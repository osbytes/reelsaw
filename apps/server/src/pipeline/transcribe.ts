import path from "node:path";
import fs from "node:fs/promises";
import { eq, asc } from "drizzle-orm";
import { transcribe as aiTranscribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { schema } from "../db/index.js";
import { QUEUES } from "../queue/boss.js";
import { StageContext, exists } from "./common.js";
import { toWords, toSentences, offsetSegments, type RawSegment } from "./transcript.js";
import { extractEntities, biasProviderOptions } from "./entities.js";
import { providerOf } from "../ai/registry.js";
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
    await enqueueRefine(svc, projectId);
    return;
  }

  await ctx.start("transcribing");
  const sourcePath = await ctx.ensureSource(project);
  await svc.resources.acquire({ kind: "transcribe", needDiskMB: 512, signal: ctx.signal, onWait: (r) => void ctx.progress(0, `Waiting for resources: ${r}`).catch(() => {}) });

  const audioPath = path.join(dir, "audio.mp3");
  if (!(await exists(audioPath))) {
    await ctx.progress(0.02, "Extracting audio");
    await svc.media.extractAudio(sourcePath, audioPath, ctx.signal);
  }

  const chunkDir = path.join(dir, "chunks");
  await fs.mkdir(chunkDir, { recursive: true });
  let chunkFiles = (await fs.readdir(chunkDir)).filter((f) => f.endsWith(".mp3")).sort();
  if (!chunkFiles.length) {
    await ctx.progress(0.05, "Splitting audio into chunks");
    await svc.media.segmentAudio(audioPath, path.join(chunkDir, "chunk_%04d.mp3"), svc.config.TRANSCRIBE_CHUNK_SECONDS, ctx.signal);
    chunkFiles = (await fs.readdir(chunkDir)).filter((f) => f.endsWith(".mp3")).sort();
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

  const model = await svc.ai.transcriptionModel();
  const entities = extractEntities(project.sourceMeta, project.settings.vocabulary);
  const provider = providerOf(svc.config.TRANSCRIPTION_MODEL);
  const providerOptions = svc.ai.transcriptionOptions() as Record<string, JSONObject>;
  if (svc.config.TRANSCRIPT_BIAS && entities.length) {
    providerOptions[provider] = { ...(providerOptions[provider] ?? {}), ...(biasProviderOptions(provider, entities) as JSONObject) };
    ctx.log.info({ count: entities.length, hints: entities.slice(0, 12) }, "vocabulary hints");
  }

  const selfHosted = provider === "openai" && !!svc.config.OPENAI_BASE_URL;
  const concurrency = svc.config.TRANSCRIBE_CONCURRENCY || (selfHosted ? 1 : 3);
  const pending = chunkFiles.map((_, i) => i).filter((i) => !doneIdx.has(i));
  let completed = chunkFiles.length - pending.length;
  const worker = async () => {
    for (;;) {
      const i = pending.shift();
      if (i === undefined) return;
      ctx.throwIfAborted();
      const audio = await fs.readFile(path.join(chunkDir, chunkFiles[i]!));
      const result = await aiTranscribe({
        model,
        audio,
        providerOptions,
        abortSignal: ctx.signal,
        maxRetries: 3,
        telemetry: { isEnabled: svc.otel.enabled, functionId: "transcribe.chunk", recordOutputs: false },
      });
      await ctx.db
        .insert(schema.transcriptChunks)
        .values({
          id: `${projectId}:${i}`,
          projectId,
          index: i,
          offsetSec: offsets[i]!,
          language: result.language ?? null,
          text: result.text,
          segments: result.segments.map((s) => ({ text: s.text, start: s.startSecond, end: s.endSecond })),
        })
        .onConflictDoNothing();
      completed++;
      await ctx.progress(0.1 + (0.85 * completed) / chunkFiles.length, `Transcribed chunk ${completed}/${chunkFiles.length}`);
    }
  };
  await ctx.progress(0.1, `Transcribing ${chunkFiles.length} chunk(s), ${concurrency} at a time`);
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker));

  const chunks = await ctx.db.query.transcriptChunks.findMany({ where: eq(schema.transcriptChunks.projectId, projectId), orderBy: asc(schema.transcriptChunks.index) });
  if (chunks.length !== chunkFiles.length) throw new Error(`Expected ${chunkFiles.length} transcript chunks, have ${chunks.length}`);

  const raw: RawSegment[] = chunks.flatMap((c) =>
    offsetSegments(
      c.segments.map((s) => ({ text: s.text, startSecond: s.start, endSecond: s.end })),
      c.offsetSec,
    ),
  );
  const words = toWords(raw);
  if (!words.length) throw new Error("Transcription returned no words. Is the audio silent?");
  const sentences = toSentences(words);

  await ctx.db
    .insert(schema.transcripts)
    .values({
      projectId,
      language: chunks.find((c) => c.language)?.language ?? null,
      text: chunks.map((c) => c.text.trim()).join(" "),
      words,
      rawWords: words,
      flags: [],
      entities,
      refine: {},
      segments: sentences,
      sceneCuts: null,
    })
    .onConflictDoNothing();

  await ctx.complete({ words: words.length, sentences: sentences.length, entities: entities.length, chunks: chunkFiles.length });
  await enqueueRefine(svc, projectId);
}

export { QUEUES };
