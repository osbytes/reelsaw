import path from "node:path";
import fs from "node:fs/promises";
import { eq, asc } from "drizzle-orm";
import type { JSONObject } from "@ai-sdk/provider";
import type { TranscriptFlag, Word } from "@reelsaw/shared";
import { schema } from "../db/index.js";
import { QUEUES } from "../queue/boss.js";
import { StageContext, StaleJobError, exists, lockCurrentStage, modelsUsed } from "./common.js";
import { toWords, toSentences, offsetSegments, type RawSegment } from "./transcript.js";
import { extractEntities, biasProviderOptions, applyFlags } from "./entities.js";
import { collapseDecoderLoopsWithStats, compressionRatio, flagsFromCollapse, preferLessRepetitive, shouldRetryWithoutPrompt, withoutPrompt, type LoopRun } from "./asr-loops.js";
import { underlyingProvider } from "../ai/registry.js";
import { enqueueRefine } from "./refine.js";

/**
 * Transcribe stage: audio → chunks → words. Chunks are checkpointed per row so a crash resumes
 * where it stopped, and run with bounded concurrency. Cleanup (names, disfluencies, scene cuts)
 * is fanned out to the refine jobs so each can fail, retry and re-run on its own.
 */
export async function transcribe(ctx: StageContext) {
  const { svc, projectId } = ctx;
  const project = await ctx.project();
  const dir = await ctx.dir();

  const existing = await ctx.db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { projectId: true } });
  if (existing) {
    ctx.log.info("transcript exists, moving on to refine");
    // the same fence as ctx.complete: transcript lock first, then the project row, and only while this job's version is current
    await svc.tx(async (u) => {
      await u.db.select({ id: schema.transcripts.projectId }).from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
      if (!(await lockCurrentStage(u.db, projectId, ctx.seq))) throw new StaleJobError(projectId, ctx.seq);
      await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
    });
    return;
  }

  await ctx.start("transcribing");
  await ctx.acquire("transcribe", 512);
  const sourcePath = await ctx.ensureSource(project); // leases the pull itself when the copy is missing

  // Both outputs are built under a .part name and renamed, so a crash (OOM, SIGKILL, heartbeat
  // timeout) mid-write can never leave a truncated file a retry would trust.
  const audioPath = path.join(dir, "audio.mp3");
  const audioPart = `${audioPath}.part`;
  await fs.rm(audioPart, { force: true });
  if (!(await exists(audioPath))) {
    await ctx.progress(0.02, "Extracting audio");
    await svc.media.extractAudio(sourcePath, audioPart, ctx.signal);
    await fs.rename(audioPart, audioPath);
  }

  const chunkDir = path.join(dir, "chunks");
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

  // the model in force when this stage starts; every chunk of this run uses it even if an admin switches meanwhile
  const transcriptionModel = svc.models.get().transcription;
  await svc.ai.transcriptionModel(transcriptionModel); // fail fast if the model id is wrong
  const entities = extractEntities(project.sourceMeta, project.settings.vocabulary);
  const provider = underlyingProvider(transcriptionModel);
  const providerOptions = svc.ai.transcriptionOptions(transcriptionModel) as Record<string, JSONObject>;
  if (svc.config.TRANSCRIPT_BIAS && entities.length) {
    providerOptions[provider] = { ...(providerOptions[provider] ?? {}), ...(biasProviderOptions(provider, entities) as JSONObject) };
    ctx.log.info({ count: entities.length, hints: entities.slice(0, 12) }, "vocabulary hints");
  }

  const selfHosted = provider === "openai" && !!svc.providers.get("openai").baseUrl;
  const concurrency = svc.config.TRANSCRIBE_CONCURRENCY || (selfHosted ? 1 : 3);
  const pending = chunkFiles.map((_, i) => i).filter((i) => !doneIdx.has(i));
  let completed = chunkFiles.length - pending.length;
  ctx.log.info({ model: transcriptionModel, provider, selfHosted, chunks: chunkFiles.length, alreadyDone: completed, concurrency, chunkSeconds: svc.config.TRANSCRIBE_CHUNK_SECONDS, audioSec: Math.round(acc), biasHints: entities.length }, "transcribe start");
  const worker = async () => {
    for (;;) {
      const i = pending.shift();
      if (i === undefined) return;
      ctx.throwIfAborted();
      const audio = await fs.readFile(path.join(chunkDir, chunkFiles[i]!));
      let result = await svc.asr.transcribe(audio, { modelId: transcriptionModel, providerOptions, signal: ctx.signal, maxRetries: 3, functionId: "transcribe.chunk", telemetry: svc.otel.enabled });
      // whisper-1 has no temperature-fallback; a vocabulary `prompt` that leaked, or a 30 s
      // internal window that started looping, poisons the rest of this 10-minute file. Retry once
      // without the prompt (openai/whisper compression_ratio_threshold = 2.4).
      const prompted = typeof (providerOptions[provider] as { prompt?: unknown } | undefined)?.prompt === "string";
      if (shouldRetryWithoutPrompt(result.text, prompted)) {
        ctx.log.warn({ chunk: i, compressionRatio: Number(compressionRatio(result.text).toFixed(2)), chars: result.text.length }, "chunk looks like a decoder loop; retrying without vocabulary prompt");
        const retried = await svc.asr.transcribe(audio, { modelId: transcriptionModel, providerOptions: withoutPrompt(providerOptions, provider), signal: ctx.signal, maxRetries: 3, functionId: "transcribe.chunk-retry", telemetry: svc.otel.enabled });
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
          language: result.language ?? null,
          text: result.text,
          segments: result.segments.map((sg) => ({ text: sg.text, start: sg.startSecond, end: sg.endSecond })),
        })
        .onConflictDoNothing();
      completed++;
      ctx.log.debug({ chunk: i, offsetSec: offsets[i], language: result.language, empty: result.text.trim().length === 0 }, "chunk transcribed");
      await ctx.progress(0.1 + (0.85 * completed) / chunkFiles.length, `Transcribed chunk ${completed}/${chunkFiles.length}`);
    }
  };
  await ctx.progress(0.1, `Transcribing ${chunkFiles.length} chunk(s), ${concurrency} at a time`);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker));

  const chunks = await ctx.db.query.transcriptChunks.findMany({ where: eq(schema.transcriptChunks.projectId, projectId), orderBy: asc(schema.transcriptChunks.index) });
  if (chunks.length !== chunkFiles.length) throw new Error(`Expected ${chunkFiles.length} transcript chunks, have ${chunks.length}`);

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
    const heard = toWords(segs, { collapseLoops: false });
    const collapsed = collapseDecoderLoopsWithStats(heard);
    const offset = rawWords.length;
    rawWords.push(...heard);
    dropped += collapsed.dropped;
    loopRuns.push(...collapsed.runs);
    for (const f of flagsFromCollapse(heard, collapsed)) flags.push({ ...f, wordIndex: f.wordIndex + offset });
  }
  if (dropped) ctx.log.info({ dropped, runs: loopRuns.length, flags: flags.length, samples: loopRuns.slice(0, 8) }, "collapsed ASR decoder-loop repeats");
  const words = applyFlags(rawWords, flags);
  if (!words.length) throw new Error("Transcription returned no words. Is the audio silent?");
  const sentences = toSentences(words);

  await ctx.complete({ words: words.length, sentences: sentences.length, entities: entities.length, chunks: chunkFiles.length, loops: flags.length, loopDropped: dropped }, async (u) => {
  // which STT ran, so later expected-time estimates compare like with like (see pipeline/estimates.ts)
  await u.artifact(projectId, "transcribe", "models", { chunks: chunkFiles.length, words: words.length }, { ...modelsUsed(svc, "transcription", "align"), transcription: transcriptionModel });
  await u.db
    .insert(schema.transcripts)
    .values({
      projectId,
      language: chunks.find((c) => c.language)?.language ?? null,
      text: words.map((w) => w.text).join(" "),
      words,
      rawWords,
      flags,
      entities,
      refine: {},
      segments: sentences,
      sceneCuts: null,
    })
    .onConflictDoNothing();
    await enqueueRefine(svc, projectId, ctx.seq, undefined, u);
  });
}

export { QUEUES };
