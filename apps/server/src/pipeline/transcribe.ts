import { languageForModel } from "../ai/spoken-languages.js";
import path from "node:path";
import fs from "node:fs/promises";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { JSONObject } from "@ai-sdk/provider";
import {
  type RangeOrigin,
  type Span,
  type TranscriptFlag,
  type Word,
  mergeSpans,
  processedEndSec,
  spansSec,
  subtractSpans,
  transcriptSpans,
} from "@reelsaw/shared";
import { type Db, schema } from "../db/index.js";
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
 * The source time a project's transcript must cover: its ranges (`transcriptSpans`), or, for a project ingested before
 * ranges existed (by the previous version, mid-rollout), the part `source_limit_sec` says it processes.
 */
export function neededSpans(
  p: { durationSec: number | null; sourceLimitSec?: number | null },
  ranges: readonly { startSec: number; endSec: number; origin: RangeOrigin }[],
): [number, number][] {
  if (ranges.length) return transcriptSpans(ranges, p.durationSec);
  const end = processedEndSec(p);
  return end ? [[0, end]] : [];
}

/** Everything: what a transcript with no `covered` spans covers (written whole). */
const ALL_TIME: Span[] = [[0, Number.MAX_SAFE_INTEGER]];

/**
 * The source time a transcript covers: its spans, or all of it when it has none (a transcript written whole, by an
 * SRT / VTT import, a seeded scenario or a row from before spans). The one reader of `transcripts.covered`.
 */
export function coverageOf(covered: Span[] | null | undefined): Span[] {
  return covered ?? ALL_TIME;
}

/**
 * What the previous version reads from the deprecated `covered_sec`: the covered end of a transcript of the video's
 * start, null for the whole video (or for ranges, which that version never clips past).
 */
export function legacyCoveredSec(covered: readonly Span[], durationSec: number | null): number | null {
  const [only, ...more] = covered;
  if (!only || more.length || only[0] > 0.5) return null;
  return durationSec !== null && only[1] >= durationSec - 0.5 ? null : only[1];
}

/** A chunk shorter than this is the segment muxer's leftover past the last cut (a few frames), not audio to transcribe. */
export const MIN_CHUNK_SEC = 1;

/**
 * The chunks of one stretch of audio cut from source second `startSec`, from the chunk files' real durations (the
 * segment muxer cuts on frame boundaries): each one's source offset, end and file. A sliver under MIN_CHUNK_SEC is left
 * out. A chunk row is keyed by its offset in tenths of a second (`index`), so the same audio cut again (a retry, or the
 * same range in another run) finds its row whatever else the run transcribes.
 */
export function audioChunks(startSec: number, durations: readonly number[]): { index: number; offsetSec: number; endSec: number; file: number }[] {
  const out: { index: number; offsetSec: number; endSec: number; file: number }[] = [];
  let at = startSec;
  durations.forEach((d, file) => {
    if (d >= MIN_CHUNK_SEC) out.push({ index: Math.round(at * 10), offsetSec: at, endSec: at + d, file });
    at += d;
  });
  return out;
}

type DeletedFlag = TranscriptFlag & { deletedAt: string };

/**
 * Merge newly heard words into a transcript in time order: the words of a range earlier in the video go before the
 * words already there, a later one's after. Every flag (fixes, cuts, loop collapses, soft-deleted fixes) points at
 * `rawWords` indices, so each is moved to where its words now are; nothing the user decided is lost. `words` is
 * recomputed the way refine does (applyFlags), and refine runs again over the whole transcript (it carries the user's
 * decisions over). New words only ever land between the spans already covered, so no flag straddles them.
 */
export function mergeTranscript(
  t: { words: Word[]; rawWords: Word[] | null; flags: TranscriptFlag[]; deletedFlags?: DeletedFlag[] | null },
  added: { rawWords: Word[]; flags: TranscriptFlag[] },
): { rawWords: Word[]; flags: TranscriptFlag[]; deletedFlags: DeletedFlag[]; words: Word[] } {
  const raw = t.rawWords ?? t.words;
  const oldAt: number[] = [];
  const newAt: number[] = [];
  const rawWords: Word[] = [];
  for (let i = 0, j = 0; i < raw.length || j < added.rawWords.length; ) {
    const a = raw[i];
    const b = added.rawWords[j];
    if (a && (!b || a.start <= b.start)) {
      oldAt.push(rawWords.length);
      rawWords.push(a);
      i++;
    } else if (b) {
      newAt.push(rawWords.length);
      rawWords.push(b);
      j++;
    }
  }
  const move = <F extends { wordIndex: number; span: number }>(f: F, at: readonly number[]): F => {
    const first = at[f.wordIndex] ?? rawWords.length;
    if (f.span <= 0) return { ...f, wordIndex: first };
    const last = at[f.wordIndex + f.span - 1] ?? first + f.span - 1;
    return { ...f, wordIndex: first, span: last - first + 1 };
  };
  const flags = [...t.flags.map((f) => move(f, oldAt)), ...added.flags.map((f) => move(f, newAt))].sort((a, b) => a.wordIndex - b.wordIndex);
  const deletedFlags = (t.deletedFlags ?? []).map((f) => move(f, oldAt));
  return { rawWords, flags, deletedFlags, words: applyFlags(rawWords, flags) };
}

/** The source time project `p`'s transcript must cover, from its ranges (`neededSpans`). */
export async function projectNeededSpans(db: Db, p: { id: string; durationSec: number | null; sourceLimitSec: number | null }): Promise<[number, number][]> {
  const ranges = await db
    .select({ startSec: schema.projectRanges.startSec, endSec: schema.projectRanges.endSec, origin: schema.projectRanges.origin })
    .from(schema.projectRanges)
    .where(eq(schema.projectRanges.projectId, p.id))
    .orderBy(asc(schema.projectRanges.startSec));
  return neededSpans(p, ranges);
}

/**
 * Transcribe stage: audio → chunks → words. Each chunk is a durable step (ctx.step; rows in
 * transcript_chunks hold the words) so a crash or timeout resumes where it stopped, with bounded concurrency. Cleanup (names, disfluencies, scene cuts)
 * is fanned out to the refine jobs so each can fail, retry and re-run on its own.
 * Only the source time the project's ranges need and the transcript does not cover yet is transcribed
 * (`neededSpans` less `transcripts.covered`): the whole video, the start a partly processed one covers, a part added
 * by extendProject, or the ranges a person or a caller chose, each cut from the source on its own. A transcript that
 * exists gets the new words merged in (`mergeTranscript`).
 */
export async function transcribe(ctx: StageContext) {
  const { svc, projectId } = ctx;
  const project = await ctx.project();
  const dir = await ctx.dir();

  const existing = await ctx.db.query.transcripts.findFirst({
    where: eq(schema.transcripts.projectId, projectId),
    columns: { projectId: true, covered: true },
  });
  const coveredBefore = existing ? coverageOf(existing.covered) : [];
  const needed = await projectNeededSpans(ctx.db, project);
  /** what this run transcribes: each stretch the ranges need that the transcript does not cover */
  const targets = subtractSpans(needed, coveredBefore).filter(([s, e]) => e - s >= MIN_CHUNK_SEC);
  if (existing && !targets.length) {
    ctx.log.info("transcript exists, moving on to refine");
    // the same fence as ctx.complete: transcript lock first, then the project row, and only while this job's version is current
    await svc.tx(async (u) => {
      await u.db.select({ id: schema.transcripts.projectId }).from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
      if (!(await lockCurrentStage(u.db, projectId, ctx.seq))) throw new StaleJobError(projectId, ctx.seq);
      await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
    });
    return;
  }
  if (!targets.length) throw new Error("Nothing to transcribe: the project has no processed part yet");

  await ctx.start("transcribing");
  await ctx.acquire("transcribe", 512);

  // Each stretch is cut and chunked on its own. Both outputs are built under a .part name and renamed, so a crash (OOM,
  // SIGKILL, heartbeat timeout) mid-write can never leave a truncated file a retry would trust; named for the stretch,
  // so one stretch's audio is never mistaken for another's.
  type Chunk = ReturnType<typeof audioChunks>[number] & { path: string; span: Span };
  const chunks: Chunk[] = [];
  for (const [i, span] of targets.entries()) {
    const [s, e] = span;
    const tag = `${Math.round(s * 1000)}-${Math.round(e * 1000)}`;
    const audioPath = path.join(dir, `audio-${tag}.mp3`);
    const audioPart = `${audioPath}.part`;
    await fs.rm(audioPart, { force: true });
    if (!(await exists(audioPath))) {
      await ctx.progress(0.02, targets.length > 1 ? `Extracting audio (${i + 1}/${targets.length})` : "Extracting audio");
      const source = await ctx.sourceAt(project, span); // leases the pull itself when the copy is missing
      const toEnd = project.durationSec !== null && e >= project.durationSec - 0.01;
      await svc.media.extractAudio(source.path, audioPart, ctx.signal, { fromSec: s - source.offsetSec, durationSec: toEnd ? null : e - s });
      await fs.rename(audioPart, audioPath);
    }
    const chunkDir = path.join(dir, `chunks-${tag}`);
    const chunkPart = `${chunkDir}.part`;
    await fs.rm(chunkPart, { recursive: true, force: true });
    const listChunks = async () => (await fs.readdir(chunkDir).catch(() => [])).filter((f) => f.endsWith(".mp3")).sort();
    let files = await listChunks();
    if (!files.length) {
      await ctx.progress(0.05, "Splitting audio into chunks");
      await fs.rm(chunkDir, { recursive: true, force: true });
      await fs.mkdir(chunkPart, { recursive: true });
      await svc.media.segmentAudio(audioPath, path.join(chunkPart, "chunk_%04d.mp3"), svc.config.TRANSCRIBE_CHUNK_SECONDS, ctx.signal);
      await fs.rename(chunkPart, chunkDir);
      files = await listChunks();
    }
    if (!files.length) throw new Error("Audio chunking produced no files");
    // exact offsets from each chunk's real duration (the segment muxer cuts on frame boundaries)
    const durations: number[] = [];
    for (const f of files) durations.push((await svc.media.ffprobe(path.join(chunkDir, f))).durationSec);
    for (const c of audioChunks(s, durations)) chunks.push({ ...c, path: path.join(chunkDir, files[c.file] ?? ""), span });
  }
  if (!chunks.length) throw new Error(`No audio in ${plural(targets.length, "stretch")} to transcribe`);
  // Rows already there are reused by offset (transcribeChunk) whatever run wrote them; a row cut at another offset is
  // transcribed again. No row is deleted by age: an attempt's saved steps (job_steps) would be reused without writing
  // the row back, and the run would fail on the count below.

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
      chunks: chunks.length,
      spans: targets.length,
      neededSec: Math.round(spansSec(targets)),
      concurrency,
      chunkSeconds: svc.config.TRANSCRIBE_CHUNK_SECONDS,
      biasHints: entities.length,
      language: spoken ?? "detect",
    },
    "transcribe start",
  );

  // One durable step per chunk (progress, time left, idle timeout and retry accounting come from the step layer, as in
  // analyze). The words stay in transcript_chunks: a step's saved output is only counts, and a chunk that already has a
  // row (a run from before steps, or a step lost with its row kept) is not transcribed again.
  const transcribeChunk = async (c: Chunk, audio: Buffer, signal: AbortSignal) => {
    const t0 = Date.now();
    const row = await ctx.db.query.transcriptChunks.findFirst({
      where: and(eq(schema.transcriptChunks.projectId, projectId), eq(schema.transcriptChunks.index, c.index)),
    });
    // a row from a run that cut the audio elsewhere (another chunk length) is a different stretch, and one heard in
    // another language than the one now set (a run before the setting changed) has the wrong words: transcribe again
    const sameLanguage = !spoken || languageCode(row?.language) === spoken;
    if (row && Math.abs(row.offsetSec - c.offsetSec) < 1 && sameLanguage) return chunkStepOutput(c.index, row.text, row.segments.length, 0, true);
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
        { chunk: c.index, compressionRatio: Number(compressionRatio(result.text).toFixed(2)), chars: result.text.length },
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
          chunk: c.index,
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
        id: `${projectId}:${c.index}`,
        projectId,
        index: c.index,
        offsetSec: c.offsetSec,
        // the language it was transcribed in: the one sent, else the one the model detected (see the reuse above)
        language: spoken ?? result.language ?? null,
        text: result.text,
        segments: result.segments.map((sg) => ({ text: sg.text, start: sg.startSecond, end: sg.endSecond })),
      })
      .onConflictDoNothing();
    ctx.log.debug({ chunk: c.index, offsetSec: c.offsetSec, language: result.language, empty: result.text.trim().length === 0 }, "chunk transcribed");
    return chunkStepOutput(c.index, result.text, result.segments.length, Date.now() - t0);
  };
  await ctx.progress(0.1, `Transcribing ${plural(chunks.length, "chunk")}, ${concurrency} at a time`);
  await ctx.steps(chunks, { concurrency, range: [0.1, 0.95], message: (d, t) => `Transcribed chunk ${d}/${t}` }, async (c, _k, signal) => {
    const audio = await fs.readFile(c.path);
    const cacheKey = svc.asr.keyFor(audio, { modelId: transcriptionModel, providerOptions, language: spoken });
    const timeoutMs = ctx.unitTimeoutMs(transcriptionModel, { audioSec: c.endSec - c.offsetSec });
    return ctx.step(chunkStepName(c.index), chunkStepKey(cacheKey, transcriptionModel, c.index, c.offsetSec), (sig) => transcribeChunk(c, audio, sig), {
      schema: chunkStepSchema,
      timeoutMs,
      model: transcriptionModel,
      signal,
    });
  });

  const byIndex = new Map(chunks.map((c) => [c.index, c]));
  const rows = (
    await ctx.db.query.transcriptChunks.findMany({
      where: and(eq(schema.transcriptChunks.projectId, projectId), inArray(schema.transcriptChunks.index, [...byIndex.keys()])),
      orderBy: asc(schema.transcriptChunks.offsetSec),
    })
  ).filter((r) => {
    const c = byIndex.get(r.index);
    return !!c && Math.abs(r.offsetSec - c.offsetSec) < 1;
  });
  if (rows.length !== chunks.length) throw new Error(`Expected ${chunks.length} transcript chunks, have ${rows.length}`);

  // Collapse per chunk: decoder loops don't span API calls, and a cheer that happens to sit on a
  // 10-minute cut must not be merged with the next chunk's first words. rawWords stay as-heard;
  // applyFlags layers the collapse (rejecting a loop flag restores the repeated copies).
  const rawWords: Word[] = [];
  const flags: TranscriptFlag[] = [];
  let dropped = 0;
  const loopRuns: LoopRun[] = [];
  for (const r of rows) {
    const [from, to] = byIndex.get(r.index)?.span ?? [0, 0];
    const segs: RawSegment[] = offsetSegments(
      r.segments.map((x) => ({ text: x.text, startSecond: x.start, endSecond: x.end })),
      r.offsetSec,
    );
    // only the words of the stretch this run transcribes: a chunk row cut elsewhere may reach past it
    const heard = toWords(segs, { collapseLoops: false, language: spoken ?? languageCode(r.language) }).filter((w) => w.start >= from - 0.05 && w.start < to);
    const collapsed = collapseDecoderLoopsWithStats(heard);
    const offset = rawWords.length;
    rawWords.push(...heard);
    dropped += collapsed.dropped;
    loopRuns.push(...collapsed.runs);
    for (const f of flagsFromCollapse(heard, collapsed)) flags.push({ ...f, wordIndex: f.wordIndex + offset });
  }
  if (dropped) ctx.log.info({ dropped, runs: loopRuns.length, flags: flags.length, samples: loopRuns.slice(0, 8) }, "collapsed ASR decoder-loop repeats");
  if (existing)
    return mergeRest(ctx, { coveredBefore, targets, durationSec: project.durationSec, rawWords, flags, chunks: chunks.length, loopDropped: dropped });
  const words = applyFlags(rawWords, flags);
  // every chunk is a saved step, so another attempt replays the same empty answer: fail the run now
  if (!words.length) throw new NonRetryableError("Transcription returned no words. Is the audio silent?");
  const language = spoken ?? languageCode(rows.find((c) => c.language)?.language) ?? null;
  const sentences = toSentences(words, undefined, language);
  // what will work less well for this language, said once now, before anything renders (refine reports its own skips)
  // informational: a font check that cannot run leaves captions unchecked, it never fails the transcription
  const fonts = language
    ? await languageFonts(svc, [language]).catch((err: unknown) => {
        ctx.log.warn({ err }, "could not check the caption fonts for this language");
        return undefined;
      })
    : undefined;
  const gaps = language ? languageGaps(language, fonts).filter((g) => !REFINE_REPORTS.has(g.stage)) : [];
  if (gaps.length) ctx.log.info({ language, gaps: gaps.map(gapLine) }, "stages that do less for this language");

  const covered = mergeSpans(targets);
  await ctx.complete(
    { words: words.length, sentences: sentences.length, entities: entities.length, chunks: chunks.length, loops: flags.length, loopDropped: dropped },
    async (u) => {
      // which STT ran, so later expected-time estimates compare like with like (see pipeline/estimates.ts)
      await u.artifact(
        projectId,
        "transcribe",
        "models",
        { chunks: chunks.length, words: words.length },
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
          covered,
          coveredSec: legacyCoveredSec(covered, project.durationSec),
        })
        .onConflictDoNothing();
      for (const g of gaps) await u.emit("language.degraded", { projectId, stage: g.stage, language: language!, reason: gapLine(g) });
      await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
    },
  );
}

/**
 * Adding to a transcript: the new words merged in, the covered spans grown, every refine step queued again (they carry
 * the user's decisions over), in one unit. Transcript lock first, then the project row (the stage fence), like
 * ctx.complete. A transcript whose coverage moved since this run read it (this job ran twice) only hands off.
 */
async function mergeRest(
  ctx: StageContext,
  r: { coveredBefore: Span[]; targets: Span[]; durationSec: number | null; rawWords: Word[]; flags: TranscriptFlag[]; chunks: number; loopDropped: number },
) {
  const { svc, projectId } = ctx;
  let added = 0;
  await svc.tx(async (u) => {
    added = 0;
    const [t] = await u.db.select().from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
    if (!t) throw new Error("Transcript missing while extending it");
    if (!(await lockCurrentStage(u.db, projectId, ctx.seq))) throw new StaleJobError(projectId, ctx.seq);
    const durationSec = await stageElapsed(u.db, projectId, "transcribe");
    // only onto the transcript these words were heard for: one whose coverage moved meanwhile was grown by that run
    if (JSON.stringify(coverageOf(t.covered)) === JSON.stringify(r.coveredBefore)) {
      const merged = mergeTranscript(t, { rawWords: r.rawWords, flags: r.flags });
      const segments = toSentences(merged.words, undefined, t.language);
      const covered = mergeSpans([...coverageOf(t.covered), ...r.targets]);
      added = r.rawWords.length;
      await u.db
        .update(schema.transcripts)
        .set({
          rawWords: merged.rawWords,
          flags: merged.flags,
          deletedFlags: merged.deletedFlags,
          words: merged.words,
          segments,
          text: segments.map((s) => s.text).join(" "),
          covered,
          coveredSec: legacyCoveredSec(covered, r.durationSec),
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
      extended: { spans: r.targets },
      words: added,
      chunks: r.chunks,
      loopDropped: r.loopDropped,
      ...(durationSec !== undefined ? { durationSec } : {}),
    });
    await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
  });
  ctx.log.info({ spans: r.targets, words: added }, "transcript extended");
}

/** Stages whose skip refine records itself when it gets to them (pipeline/refine.ts skipMessage). */
const REFINE_REPORTS = new Set(["disfluencyRules", "entityPhonetics"]);

export { QUEUES };
