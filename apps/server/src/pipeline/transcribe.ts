import { languageForModel } from "../ai/spoken-languages.js";
import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, asc } from "drizzle-orm";
import type { JSONObject } from "@ai-sdk/provider";
import type { TranscriptFlag, Word } from "@reelsaw/shared";
import { schema } from "../db/index.js";
import { QUEUES } from "../queue/boss.js";
import { NonRetryableError, type StageContext, StaleJobError, exists, lockCurrentStage, modelsUsed, stageElapsed } from "./common.js";
import { toWords, toSentences, offsetSegments, type RawSegment } from "./transcript.js";
import { extractEntities, biasProviderOptions, applyFlags } from "./entities.js";
import {
  chunkStepKey,
  chunkStepName,
  chunkStepOutput,
  chunkStepSchema,
  collapseDecoderLoopsWithStats,
  compressionRatio,
  flagsFromCollapse,
  preferLessRepetitive,
  shouldRetryWithoutPrompt,
  withoutPrompt,
  type LoopRun,
} from "./asr-loops.js";
import { isSelfHostedModel } from "../ai/self-hosted.js";
import { enqueueRefine } from "./refine.js";
import { languageCode, languageGaps, gapLine } from "./language.js";
import { languageFonts } from "../languages.js";
import { plural } from "@reelsaw/shared";

/**
 * Whether a transcript that covers [0, coveredSec) of the source (null = all of it) has every word the project's work
 * needs, up to `limit` (`projects.source_limit_sec`; null = the whole video).
 */
export function transcriptCovers(coveredSec: number | null, limit: number | null): boolean {
  if (coveredSec === null) return true;
  if (limit === null) return false;
  return coveredSec >= limit - 0.5;
}

/** A chunk shorter than this is the segment muxer's leftover past the last cut (a few frames), not audio to transcribe. */
export const MIN_CHUNK_SEC = 1;

/**
 * Chunks a run must transcribe: every one that ends past `fromSec` (0 for a new transcript, the covered end when a
 * partly processed video is extended). The chunks before it are in the transcript already. A sliver under
 * MIN_CHUNK_SEC is left out: audio cut at a partial project's limit ends a few milliseconds past the last whole chunk,
 * and a row for that sliver (empty) would stand in for the real chunk that starts there once the video is extended.
 */
export function chunksFrom(offsets: readonly number[], totalSec: number, fromSec: number): number[] {
  return offsets.flatMap((o, i) => {
    const end = offsets[i + 1] ?? totalSec;
    return end > fromSec + 0.5 && end - o >= MIN_CHUNK_SEC ? [i] : [];
  });
}

/**
 * Append the words of the rest of a partly processed video to its transcript. Indices of the words already there do
 * not move, so every fix, cut and decision on them (flags point at `rawWords` indices) stays where it was; the new
 * flags (decoder-loop collapses found in the new chunks) are shifted past them. `words` is recomputed the way refine
 * does (applyFlags), and refine runs again over the whole transcript (it carries the user's decisions over).
 */
export function appendTranscript(
  t: { words: Word[]; rawWords: Word[] | null; flags: TranscriptFlag[] },
  added: { rawWords: Word[]; flags: TranscriptFlag[] },
): { rawWords: Word[]; flags: TranscriptFlag[]; words: Word[] } {
  const raw = t.rawWords ?? t.words;
  const rawWords = [...raw, ...added.rawWords];
  const flags = [...t.flags, ...added.flags.map((f) => ({ ...f, wordIndex: f.wordIndex + raw.length }))].sort((a, b) => a.wordIndex - b.wordIndex);
  return { rawWords, flags, words: applyFlags(rawWords, flags) };
}

/**
 * Transcribe stage: audio → chunks → words. Each chunk is a durable step (ctx.step; rows in
 * transcript_chunks hold the words) so a crash or timeout resumes where it stopped, with bounded concurrency. Cleanup (names, disfluencies, scene cuts)
 * is fanned out to the refine jobs so each can fail, retry and re-run on its own.
 * A partly processed video (`projects.source_limit_sec`) transcribes only its start; when the limit moves (extendProject),
 * the same stage transcribes the chunks past what the transcript covers and appends them (`appendTranscript`).
 */
export async function transcribe(ctx: StageContext) {
  const { svc, projectId } = ctx;
  const project = await ctx.project();
  const dir = await ctx.dir();
  const limit = project.sourceLimitSec ?? null;

  const existing = await ctx.db.query.transcripts.findFirst({
    where: eq(schema.transcripts.projectId, projectId),
    columns: { projectId: true, coveredSec: true },
  });
  if (existing && transcriptCovers(existing.coveredSec, limit)) {
    ctx.log.info("transcript exists, moving on to refine");
    // the same fence as ctx.complete: transcript lock first, then the project row, and only while this job's version is current
    await svc.tx(async (u) => {
      await u.db.select({ id: schema.transcripts.projectId }).from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
      if (!(await lockCurrentStage(u.db, projectId, ctx.seq))) throw new StaleJobError(projectId, ctx.seq);
      await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
    });
    return;
  }

  /** where this run starts: the transcript's covered end when it extends one, else the beginning */
  const fromSec = existing?.coveredSec ?? 0;
  await ctx.start("transcribing");
  await ctx.acquire("transcribe", 512);
  const sourcePath = await ctx.ensureSource(project); // leases the pull itself when the copy is missing

  // Both outputs are built under a .part name and renamed, so a crash (OOM, SIGKILL, heartbeat
  // timeout) mid-write can never leave a truncated file a retry would trust. Named for the limit, so the audio of a
  // partial run is never mistaken for the whole video's once the limit moves.
  const suffix = limit !== null ? `-${Math.round(limit)}` : "";
  const audioPath = path.join(dir, `audio${suffix}.mp3`);
  const audioPart = `${audioPath}.part`;
  await fs.rm(audioPart, { force: true });
  if (!(await exists(audioPath))) {
    await ctx.progress(0.02, "Extracting audio");
    await svc.media.extractAudio(sourcePath, audioPart, ctx.signal, limit);
    await fs.rename(audioPart, audioPath);
  }

  const chunkDir = path.join(dir, `chunks${suffix}`);
  const chunkPart = `${chunkDir}.part`;
  await fs.rm(chunkPart, { recursive: true, force: true });
  const listChunks = async () => (await fs.readdir(chunkDir).catch(() => [])).filter((f) => f.endsWith(".mp3")).sort();
  let chunkFiles = await listChunks();
  if (!chunkFiles.length) {
    await ctx.progress(0.05, "Splitting audio into chunks");
    await fs.rm(chunkDir, { recursive: true, force: true });
    await fs.mkdir(chunkPart, { recursive: true });
    await svc.media.segmentAudio(audioPath, path.join(chunkPart, "chunk_%04d.mp3"), svc.config.TRANSCRIBE_CHUNK_SECONDS, ctx.signal);
    await fs.rename(chunkPart, chunkDir);
    chunkFiles = await listChunks();
  }
  if (!chunkFiles.length) throw new Error("Audio chunking produced no files");

  // exact offsets from each chunk's real duration (the segment muxer cuts on frame boundaries)
  const offsets: number[] = [];
  let acc = 0;
  for (const f of chunkFiles) {
    offsets.push(acc);
    acc += (await svc.media.ffprobe(path.join(chunkDir, f))).durationSec;
  }

  const done = await ctx.db.query.transcriptChunks.findMany({ where: eq(schema.transcriptChunks.projectId, projectId), columns: { index: true } });
  const doneIdx = new Set(done.map((c) => c.index));
  const needed = chunksFrom(offsets, acc, fromSec);
  if (!needed.length) throw new Error(`No audio past ${Math.round(fromSec)}s to transcribe`);
  // Rows already there are reused by index (transcribeChunk) whatever run wrote them: a partial run's chunks end on the
  // chunk boundaries an extension cuts at (partialUntil), its sliver past the limit never gets a row (chunksFrom), and a
  // row cut at another offset is transcribed again. No row is deleted by age: an attempt's saved steps (job_steps) would
  // be reused without writing the row back, and the run would fail on the count below.

  // the model in force when this stage starts; every chunk of this run uses it even if an admin switches meanwhile
  const transcriptionModel = svc.models.get().transcription;
  await svc.ai.transcriptionModel(transcriptionModel); // fail fast if the model id is wrong
  const entities = extractEntities(project.sourceMeta, project.settings.vocabulary);
  const provider = svc.ai.transcriptionOptionsKey(transcriptionModel);
  const providerOptions = svc.ai.transcriptionOptions(transcriptionModel) as Record<string, JSONObject>;
  // the language the user set (project settings or their defaults) is sent, not left to detection; asr merges it into
  // the options, so it is part of the ASR cache key and the chunk step key: changing it transcribes again. One the
  // model does not take is left to detection instead of failing every chunk (ai/spoken-languages.ts)
  const spoken = await languageForModel(svc, transcriptionModel, project.settings.language);
  if (svc.config.TRANSCRIPT_BIAS && entities.length) {
    providerOptions[provider] = { ...(providerOptions[provider] ?? {}), ...(biasProviderOptions(provider, entities) as JSONObject) };
    ctx.log.info({ count: entities.length, hints: entities.slice(0, 12) }, "vocabulary hints");
  }

  const selfHosted = isSelfHostedModel({ AI_MODEL: transcriptionModel, OPENAI_BASE_URL: svc.providers.get("openai").baseUrl });
  const concurrency = svc.config.TRANSCRIBE_CONCURRENCY || (selfHosted ? 1 : 3);
  ctx.log.info(
    {
      model: transcriptionModel,
      provider,
      selfHosted,
      chunks: chunkFiles.length,
      needed: needed.length,
      fromSec,
      limitSec: limit,
      alreadyDone: doneIdx.size,
      concurrency,
      chunkSeconds: svc.config.TRANSCRIBE_CHUNK_SECONDS,
      audioSec: Math.round(acc),
      biasHints: entities.length,
      language: spoken ?? "detect",
    },
    "transcribe start",
  );

  // One durable step per chunk (progress, time left, idle timeout and retry accounting come from the step layer, as in
  // analyze). The words stay in transcript_chunks: a step's saved output is only counts, and a chunk that already has a
  // row (a run from before steps, or a step lost with its row kept) is not transcribed again.
  const transcribeChunk = async (i: number, audio: Buffer, signal: AbortSignal) => {
    const t0 = Date.now();
    const row = await ctx.db.query.transcriptChunks.findFirst({
      where: and(eq(schema.transcriptChunks.projectId, projectId), eq(schema.transcriptChunks.index, i)),
    });
    // a row from a run that cut the audio elsewhere (another chunk length) is a different stretch, and one heard in
    // another language than the one now set (a run before the setting changed) has the wrong words: transcribe again
    const sameLanguage = !spoken || languageCode(row?.language) === spoken;
    if (row && Math.abs(row.offsetSec - offsets[i]!) < 1 && sameLanguage) return chunkStepOutput(i, row.text, row.segments.length, 0, true);
    if (row) await ctx.db.delete(schema.transcriptChunks).where(eq(schema.transcriptChunks.id, row.id));
    let result = await svc.asr.transcribe(audio, {
      modelId: transcriptionModel,
      providerOptions,
      language: spoken,
      signal,
      maxRetries: 3,
      functionId: "transcribe.chunk",
      telemetry: svc.otel.enabled,
    });
    // whisper-1 has no temperature-fallback; a vocabulary `prompt` that leaked, or a 30 s
    // internal window that started looping, poisons the rest of this 10-minute file. Retry once
    // without the prompt (openai/whisper compression_ratio_threshold = 2.4).
    const prompted = typeof (providerOptions[provider] as { prompt?: unknown } | undefined)?.prompt === "string";
    if (shouldRetryWithoutPrompt(result.text, prompted)) {
      ctx.log.warn(
        { chunk: i, compressionRatio: Number(compressionRatio(result.text).toFixed(2)), chars: result.text.length },
        "chunk looks like a decoder loop; retrying without vocabulary prompt",
      );
      const retried = await svc.asr.transcribe(audio, {
        modelId: transcriptionModel,
        providerOptions: withoutPrompt(providerOptions, provider),
        language: spoken,
        signal,
        maxRetries: 3,
        functionId: "transcribe.chunk-retry",
        telemetry: svc.otel.enabled,
      });
      const picked = preferLessRepetitive(result, retried);
      ctx.log.info(
        {
          chunk: i,
          kept: picked === retried ? "retry" : "original",
          originalRatio: Number(compressionRatio(result.text).toFixed(2)),
          retryRatio: Number(compressionRatio(retried.text).toFixed(2)),
          retryChars: retried.text.length,
        },
        "chose less repetitive chunk transcript",
      );
      result = picked;
    }
    await ctx.db
      .insert(schema.transcriptChunks)
      .values({
        id: `${projectId}:${i}`,
        projectId,
        index: i,
        offsetSec: offsets[i]!,
        // the language it was transcribed in: the one sent, else the one the model detected (see the reuse above)
        language: spoken ?? result.language ?? null,
        text: result.text,
        segments: result.segments.map((sg) => ({ text: sg.text, start: sg.startSecond, end: sg.endSecond })),
      })
      .onConflictDoNothing();
    ctx.log.debug({ chunk: i, offsetSec: offsets[i], language: result.language, empty: result.text.trim().length === 0 }, "chunk transcribed");
    return chunkStepOutput(i, result.text, result.segments.length, Date.now() - t0);
  };
  await ctx.progress(0.1, `Transcribing ${plural(needed.length, "chunk")}, ${concurrency} at a time`);
  await ctx.steps(needed, { concurrency, range: [0.1, 0.95], message: (d, t) => `Transcribed chunk ${d}/${t}` }, async (i, _k, signal) => {
    const audio = await fs.readFile(path.join(chunkDir, chunkFiles[i]!));
    const cacheKey = svc.asr.keyFor(audio, { modelId: transcriptionModel, providerOptions, language: spoken });
    const timeoutMs = ctx.unitTimeoutMs(transcriptionModel, { audioSec: (offsets[i + 1] ?? acc) - offsets[i]! });
    return ctx.step(chunkStepName(i), chunkStepKey(cacheKey, transcriptionModel, i, offsets[i]!), (sig) => transcribeChunk(i, audio, sig), {
      schema: chunkStepSchema,
      timeoutMs,
      model: transcriptionModel,
      signal,
    });
  });

  const neededIdx = new Set(needed);
  const chunks = (
    await ctx.db.query.transcriptChunks.findMany({
      where: eq(schema.transcriptChunks.projectId, projectId),
      orderBy: asc(schema.transcriptChunks.index),
    })
  ).filter((c) => neededIdx.has(c.index));
  if (chunks.length !== needed.length) throw new Error(`Expected ${needed.length} transcript chunks, have ${chunks.length}`);

  // Collapse per chunk: decoder loops don't span API calls, and a cheer that happens to sit on a
  // 10-minute cut must not be merged with the next chunk's first words. rawWords stay as-heard;
  // applyFlags layers the collapse (rejecting a loop flag restores the repeated copies).
  const rawWords: Word[] = [];
  const flags: TranscriptFlag[] = [];
  let dropped = 0;
  const loopRuns: LoopRun[] = [];
  for (const c of chunks) {
    const segs: RawSegment[] = offsetSegments(
      c.segments.map((s) => ({ text: s.text, startSecond: s.start, endSecond: s.end })),
      c.offsetSec,
    );
    // a chunk that straddles where the transcript ends (another chunk length) gives only the words past it
    const heard = toWords(segs, { collapseLoops: false, language: spoken ?? languageCode(c.language) }).filter((w) => w.start >= fromSec - 0.05);
    const collapsed = collapseDecoderLoopsWithStats(heard);
    const offset = rawWords.length;
    rawWords.push(...heard);
    dropped += collapsed.dropped;
    loopRuns.push(...collapsed.runs);
    for (const f of flagsFromCollapse(heard, collapsed)) flags.push({ ...f, wordIndex: f.wordIndex + offset });
  }
  if (dropped) ctx.log.info({ dropped, runs: loopRuns.length, flags: flags.length, samples: loopRuns.slice(0, 8) }, "collapsed ASR decoder-loop repeats");
  if (existing) return appendRest(ctx, { fromSec, limit, rawWords, flags, chunks: needed.length, loopDropped: dropped });
  const words = applyFlags(rawWords, flags);
  // every chunk is a saved step, so another attempt replays the same empty answer: fail the run now
  if (!words.length) throw new NonRetryableError("Transcription returned no words. Is the audio silent?");
  const language = spoken ?? languageCode(chunks.find((c) => c.language)?.language) ?? null;
  const sentences = toSentences(words, undefined, language);
  // what will work less well for this language, said once now, before anything renders (refine reports its own skips)
  const gaps = language ? languageGaps(language, await languageFonts(svc)).filter((g) => !REFINE_REPORTS.has(g.stage)) : [];
  if (gaps.length) ctx.log.info({ language, gaps: gaps.map(gapLine) }, "stages that do less for this language");

  await ctx.complete(
    { words: words.length, sentences: sentences.length, entities: entities.length, chunks: chunkFiles.length, loops: flags.length, loopDropped: dropped },
    async (u) => {
      // which STT ran, so later expected-time estimates compare like with like (see pipeline/estimates.ts)
      await u.artifact(
        projectId,
        "transcribe",
        "models",
        { chunks: chunkFiles.length, words: words.length },
        { ...modelsUsed(svc, "transcription", "align"), transcription: transcriptionModel },
      );
      await u.db
        .insert(schema.transcripts)
        .values({
          projectId,
          // a code ("en"), never the name some models answer with ("english"); the user's setting wins over detection
          language,
          text: words.map((w) => w.text).join(" "),
          words,
          rawWords,
          flags,
          entities,
          refine: {},
          segments: sentences,
          sceneCuts: null,
          coveredSec: limit,
        })
        .onConflictDoNothing();
      for (const g of gaps) await u.emit("language.degraded", { projectId, stage: g.stage, language: language!, reason: gapLine(g) });
      await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
    },
  );
}

/**
 * The extension's commit: the new words appended to the transcript, the covered end moved to the limit, every refine
 * step queued again (they carry the user's decisions over), in one unit. Transcript lock first, then the project row
 * (the stage fence), like ctx.complete. A transcript already extended (this job ran twice) only hands off.
 */
async function appendRest(
  ctx: StageContext,
  r: { fromSec: number; limit: number | null; rawWords: Word[]; flags: TranscriptFlag[]; chunks: number; loopDropped: number },
) {
  const { svc, projectId } = ctx;
  let added = 0;
  await svc.tx(async (u) => {
    added = 0;
    const [t] = await u.db.select().from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
    if (!t) throw new Error("Transcript missing while extending it");
    if (!(await lockCurrentStage(u.db, projectId, ctx.seq))) throw new StaleJobError(projectId, ctx.seq);
    const durationSec = await stageElapsed(u.db, projectId, "transcribe");
    // only onto the transcript these words continue: one that moved meanwhile was extended by the run that moved it
    if (t.coveredSec !== null && Math.abs(t.coveredSec - r.fromSec) < 0.5) {
      const merged = appendTranscript(t, { rawWords: r.rawWords, flags: r.flags });
      const segments = toSentences(merged.words, undefined, t.language);
      added = r.rawWords.length;
      await u.db
        .update(schema.transcripts)
        .set({
          rawWords: merged.rawWords,
          flags: merged.flags,
          words: merged.words,
          segments,
          text: segments.map((s) => s.text).join(" "),
          coveredSec: r.limit,
          // every step runs again over the whole transcript; decisions on the words already there carry over (mergeRefine)
          refine: {},
        })
        .where(eq(schema.transcripts.projectId, projectId));
    }
    await u.db
      .update(schema.projects)
      .set({ stageProgress: 1, stageDetail: null, reconcileRequeues: 0, updatedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    await u.emit("stage.completed", {
      projectId,
      stage: "transcribe",
      extended: { fromSec: r.fromSec, untilSec: r.limit },
      words: added,
      chunks: r.chunks,
      loopDropped: r.loopDropped,
      ...(durationSec !== undefined ? { durationSec } : {}),
    });
    await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
  });
  ctx.log.info({ fromSec: r.fromSec, untilSec: r.limit, words: added }, "transcript extended");
}

/** Stages whose skip refine records itself when it gets to them (pipeline/refine.ts skipMessage). */
const REFINE_REPORTS = new Set(["disfluencyRules", "entityPhonetics"]);

export { QUEUES };
