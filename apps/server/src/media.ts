import { spawn, execFile } from "node:child_process";
import { llmContext } from "./ai/trace.js";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { withSpan } from "./otel.js";
import type { Logger } from "./log.js";
import { parseSceneScores, pickSceneCuts } from "./pipeline/scenes.js";
import { createYtdlpProxyPool, ffmpegCanUse, parseYtdlpProxies, type ProxySnapshot } from "./ytdlp-proxy.js";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  signal?: AbortSignal | undefined;
  /** each complete stderr line (split on \n or \r, so carriage-return progress bars arrive as lines) */
  onStderr?: ((line: string) => void) | undefined;
  /**
   * each complete stdout line; yt-dlp writes its `[download]` progress here, not to stderr. A caller that reads lines
   * gets `stdout: ""` back and keeps what it needs itself: progress output has no size bound, and buffering it all
   * once grew past V8's string limit and crashed the process (`RangeError: Invalid string length`).
   */
  onStdout?: (line: string) => void;
  /** most stdout kept when there is no `onStdout`; past it the child is killed and the run rejects (default 64 MB) */
  maxStdoutBytes?: number;
  cwd?: string;
}

/** Ceiling on a buffered stdout (ffprobe JSON, yt-dlp `--dump-single-json` are a few MB at most). */
export const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export class OutputTooLargeError extends Error {
  constructor(cmd: string, limit: number) {
    super(`${cmd} wrote more than ${Math.round(limit / 1024 / 1024)} MB to stdout; stopped it`);
  }
}
export interface ProbeInfo {
  durationSec: number;
  width?: number | undefined;
  height?: number | undefined;
  hasAudio: boolean;
  fps?: number | undefined;
  /** frames in the first video stream when the container says (an animated GIF or WebP has more than one) */
  frames?: number | undefined;
  /**
   * the only picture is a still: cover art (an audio file's artwork, `attached_pic`) or a video track of one frame.
   * Rendered as is, a clip's seek lands past that frame and ffmpeg writes sound alone (pipeline/ingest.ts stillAsVideo).
   */
  still?: boolean | undefined;
}

type ProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
};

/** ProbeInfo from ffprobe's JSON. A real video stream wins over cover art, wherever the container lists it. */
export function probeInfo(json: { format?: { duration?: string }; streams?: ProbeStream[] }): ProbeInfo {
  const videos = json.streams?.filter((s) => s.codec_type === "video") ?? [];
  const video = videos.find((s) => !s.disposition?.attached_pic) ?? videos[0];
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(json.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  let fps: number | undefined;
  if (video?.r_frame_rate) {
    const [n, d] = video.r_frame_rate.split("/").map(Number);
    if (n && d) fps = n / d;
  }
  const frames = Number(video?.nb_frames);
  return {
    durationSec: duration,
    width: video?.width,
    height: video?.height,
    hasAudio: !!audio,
    fps,
    ...(frames > 0 ? { frames } : {}),
    ...(video && (video.disposition?.attached_pic || frames === 1) ? { still: true } : {}),
  };
}

export class CommandError extends Error {
  constructor(
    public cmd: string,
    public code: number | null,
    public stderr: string,
    /** the signal that ended the process when it did not exit on its own (code is then null) */
    public signal: NodeJS.Signals | null = null,
  ) {
    // lead with the lines that say what went wrong; ffmpeg prints a long banner first
    const key = stderr
      .split("\n")
      .filter((l) => /error|invalid|fail|cannot|no such|unable|not found|unknown/i.test(l))
      .slice(-6)
      .join("\n");
    // "exited with null" said nothing: a process killed from outside (out of memory, a stopped job) has no code
    const how =
      code === null
        ? `was stopped by ${signal ?? "a signal"}${signal === "SIGKILL" ? " (usually the server running out of memory)" : ""}`
        : `exited with ${code}`;
    super(`${cmd} ${how}: ${key ? `${key}\n--- tail ---\n` : ""}${stderr.slice(-1200)}`);
  }
}

/** H.264 encoders the renders can use. libx264 is the CPU baseline every ffmpeg build has. */
export type VideoEncoder = "libx264" | "h264_nvenc" | "h264_videotoolbox";
export type EncoderSetting = VideoEncoder | "auto";
export interface EncoderChoice {
  /** encoder in use */
  name: VideoEncoder;
  /** FFMPEG_ENCODER as configured */
  requested: EncoderSetting;
  /** sentence for the operator: why this one (probe passed, fell back, pinned) */
  reason: string;
}

/**
 * The two filtergraph pools, for an encode with a filtergraph. `-threads` does not apply to filters; those
 * default to the CPU count, and a 32-core host running several jump-cut graphs then races inside `scale`
 * (`Failed to configure output pad` / EAGAIN on reinit). Filtergraph threads stay at 1: x264/NVENC take the
 * encode cores (`threads` of `media.ffmpeg`, from a lease), and overlay/scale reinit is not safe to parallelise.
 */
export function filterThreadArgs(): string[] {
  return ["-filter_threads", "1", "-filter_complex_threads", "1"];
}

/**
 * Threads of one `media.ffmpeg` pass: a CPU lease's grant (`resources.withCpu`) for a pass that decodes or
 * encodes video, or "light" (one thread) for a single frame, a stream copy or an audio pass. Required, so no pass
 * runs with ffmpeg's default of every core.
 */
export type FfmpegThreads = number | "light";

/**
 * `args` with the thread count placed where ffmpeg reads it: `-threads` is per file and binds to the file that
 * follows it, so it goes before every input (the decoders) and before the output (the encoder). A caller that
 * writes its own `-threads` is refused: the lease is the only source of the number. The filtergraph pools are
 * capped too (`filterThreadArgs`) unless the caller already did, so no pass (a stitched window, a bumper) runs a
 * filtergraph at the CPU count.
 */
export function threadedArgv(args: readonly string[], threads: FfmpegThreads): string[] {
  if (args.includes("-threads")) throw new Error("media.ffmpeg sets -threads from opts.threads (a CPU lease); remove it from the arguments");
  const t = String(threads === "light" ? 1 : Math.max(1, Math.floor(threads)));
  const filters = args.includes("-filter_threads") ? [] : filterThreadArgs();
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === "-i") out.push("-threads", t);
    if (i === args.length - 1) out.push(...filters, "-threads", t);
    out.push(a);
  });
  return out;
}

export interface SceneScanOptions {
  floor?: number;
  signal?: AbortSignal;
  range?: { start: number; duration: number };
  /** decoder threads: a CPU lease's grant (`resources.withCpu({ kind: "scene-scan", ...sceneScanCpu(pinned) }, …)`) */
  threads: number;
}

/**
 * Thread options of the shot-cut scan, input side. The pass has no encoder, so `-threads` before `-i` sizes the only
 * thing doing work, the decoder (frame threading is lossless: the scene scores are the same at any count). Placed after
 * `-i` it would bind to the null output instead and the decoder would fall back to its own default. The filtergraph
 * stays at one thread, as everywhere (see `filterThreadArgs`).
 */
function sceneScanThreadArgs(threads: number): string[] {
  return ["-threads", String(Math.max(1, Math.floor(threads))), "-filter_threads", "1"];
}

/**
 * The input half of a frame sampler that spawns ffmpeg itself: its decoder's threads, placed before `-ss`/`-i`
 * (`-threads` binds to the file that follows). A video sampler takes them from a CPU lease (`resources.withCpu`
 * with SAMPLE_CPU); a single frame or an audio-only pass takes 1. Without it the decoder uses every core.
 */
export function decodeThreadArgs(threads: number): string[] {
  return ["-threads", String(Math.max(1, Math.floor(threads)))];
}

/**
 * The output half of every frame sampler: RGB24 frames on stdout. Frame-threaded rawvideo fails to open
 * (`ff_frame_thread_encoder_init`), so the encoder gets one thread. `-threads` is per file and binds to the file that
 * follows it: before `-i` it limited only the decoder and the encoder kept frame threading, which is why it went in
 * as an input option and still failed. It sits here, right before the output, so it cannot be misplaced again.
 */
export const rgbFramesToPipe = ["-threads", "1", "-filter_threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"] as const;

/**
 * `-c:v …` and its quality settings per encoder, tuned to look alike: libx264 crf 21 is the
 * reference; NVENC's constant-quality 23 with VBR and VideoToolbox's q 65 land near it. The caller
 * adds -pix_fmt yuv420p and the frame rate.
 */
export function videoEncodeArgs(encoder: VideoEncoder): string[] {
  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-bf", "2"];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-q:v", "65", "-allow_sw", "1"];
    default:
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"];
  }
}

/** Encoders worth probing for a setting, in order; libx264 is the fallback and is never probed. */
export function encoderCandidates(requested: EncoderSetting, platform: NodeJS.Platform = process.platform): VideoEncoder[] {
  if (requested !== "auto") return requested === "libx264" ? [] : [requested];
  // VideoToolbox exists only on macOS and only outside Docker, where ffmpeg sees the host's hardware
  return platform === "darwin" ? ["h264_nvenc", "h264_videotoolbox"] : ["h264_nvenc"];
}

/** Wrapper around the external media binaries (ffmpeg, ffprobe, yt-dlp). */
export interface MediaTools {
  run(bin: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /** One ffmpeg pass; `threads` is a CPU lease's grant or "light" (`threadedArgv` places it). */
  ffmpeg(args: string[], opts: { threads: FfmpegThreads; signal?: AbortSignal | undefined; onProgress?: (sec: number) => void }): Promise<RunResult>;
  /** the H.264 encoder renders use, decided by `check()` from FFMPEG_ENCODER and a probe */
  encoder(): EncoderChoice;
  /** `-c:v …` for the encoder in use (or a named one, for a software retry after a hardware failure) */
  videoEncodeArgs(encoder?: VideoEncoder): string[];
  ffprobe(file: string): Promise<ProbeInfo>;
  /** `proxyId`: the YTDLP_PROXY candidate that served it, "direct" with no pool, "explicit" when `args` carry `--proxy` */
  /** `sections`: the download uses `--download-sections` (ffmpeg fetches it), so only HTTP proxies or direct can serve it */
  ytdlp(args: string[], opts?: RunOptions & { sections?: boolean }): Promise<RunResult & { proxyId: string }>;
  /** operator-ranked yt-dlp egress candidates and their circuit state (`reelsaw ytdlp-proxies`) */
  ytdlpProxies(): { next: string | null; candidates: ProxySnapshot[] };
  /**
   * Mono 16 kHz MP3 of the file's audio from `span.fromSec` (seconds into the file) for `span.durationSec` (null: to the
   * end); no span is all of it. A project's ranges each transcribe their own stretch (pipeline/transcribe.ts).
   */
  extractAudio(input: string, output: string, signal?: AbortSignal, span?: { fromSec: number; durationSec: number | null }): Promise<void>;
  segmentAudio(input: string, outPattern: string, chunkSeconds: number, signal?: AbortSignal): Promise<void>;
  /**
   * Shot-cut times in seconds. `floor` = minimum scene score; cuts must also stand out from local motion. With `range`,
   * only that stretch is decoded and the times are relative to `range.start` (a clip's cuts on its own clock).
   * `threads` is the decoder thread budget, required so every caller takes it from a CPU lease
   * (`resources.withCpu`, or the pure `cpuGrant` without a governor). A failed decode throws; a clean
   * run that found nothing is `[]`.
   */
  detectScenes(input: string, opts: SceneScanOptions): Promise<number[]>;
  /** Verifies every binary executes. */
  check(): Promise<void>;
}

/** Parses "time=00:01:23.45" from ffmpeg progress lines to seconds. */
export function parseProgressTime(line: string): number | undefined {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Feeds complete lines (split on \n or \r) to `onLine`, buffering the unfinished tail across chunks. A tail longer
 * than `maxLine` without a line break is dropped rather than grown without bound.
 */
export function lineSplitter(onLine?: (line: string) => void, maxLine = MAX_STDOUT_BYTES): (chunk: string) => void {
  if (!onLine) return () => {};
  let partial = "";
  let discarding = false; // the current line outgrew maxLine: skip the rest of it rather than emit its tail as a line
  let pendingCR = false; // the last chunk ended in \r: a \n opening this one finishes that same break
  return (input) => {
    // only the new chunk is scanned, so a long line costs linear time, not a rescan of everything buffered so far
    const chunk = pendingCR && input.startsWith("\n") ? input.slice(1) : input;
    pendingCR = chunk.endsWith("\r");
    const parts = chunk.split(/\r?\n|\r/);
    const last = parts.pop() ?? "";
    for (const p of parts) {
      if (discarding) discarding = false;
      else onLine(partial + p);
      partial = "";
    }
    if (discarding) return;
    partial += last;
    if (partial.length > maxLine) {
      partial = "";
      discarding = true;
    }
  };
}

/**
 * Runs a binary and collects its output. Nothing here may throw from a stream handler: an exception there is
 * uncaught, and the process (HTTP and workers) exits. Every buffer is bounded, and a handler's own error rejects the run.
 */
export function runRaw(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal: opts.signal, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const maxStdout = opts.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    // decode across chunk boundaries: a multibyte character split between two chunks would otherwise become U+FFFD
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let failure: Error | undefined;
    const fail = (err: unknown) => {
      if (failure) return;
      failure = err instanceof Error ? err : new Error(String(err));
      child.kill("SIGKILL");
    };
    const outLines = lineSplitter(opts.onStdout, maxStdout);
    const errLines = lineSplitter(opts.onStderr, 64 * 1024);
    child.stdout.on("data", (s: string) => {
      if (failure) return;
      try {
        if (opts.onStdout) return outLines(s);
        stdoutBytes += Buffer.byteLength(s);
        if (stdoutBytes > maxStdout) return fail(new OutputTooLargeError(bin, maxStdout));
        stdout += s;
      } catch (err) {
        fail(err);
      }
    });
    child.stderr.on("data", (s: string) => {
      if (failure) return;
      try {
        stderr += s;
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
        errLines(s);
      } catch (err) {
        fail(err);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (failure) reject(failure);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new CommandError(bin, code, stderr, signal));
    });
  });
}

/** argv for the log: long values cut, the proxy URL (may carry credentials) and cookies path masked. */
export function loggableArgv(args: string[]): string[] {
  return args.slice(0, 120).map((a, i) => (["--proxy", "--cookies"].includes(args[i - 1] ?? "") ? "[redacted]" : a.length > 400 ? `${a.slice(0, 400)}…` : a));
}

export function createMediaTools(config: Config, log: Logger): MediaTools {
  let encoder: EncoderChoice = { name: "libx264", requested: config.FFMPEG_ENCODER, reason: "not probed yet" };
  const ytdlpPool = createYtdlpProxyPool(config.YTDLP_PROXY ? parseYtdlpProxies(config.YTDLP_PROXY) : [], { log });

  /** Encode a few black frames with `enc`; the error text says why a hardware encoder is unusable. */
  async function probeEncoder(enc: VideoEncoder): Promise<string | null> {
    try {
      await execFileAsync(
        config.FFMPEG_PATH,
        [
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=256x256:r=30:d=0.2",
          "-frames:v",
          "3",
          "-pix_fmt",
          "yuv420p",
          ...videoEncodeArgs(enc),
          "-f",
          "null",
          "-",
        ],
        { timeout: 20_000 },
      );
      return null;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
      const text = e.killed ? "the probe timed out after 20 s" : (e.stderr ?? e.message ?? "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
      return text || "ffmpeg exited without a message";
    }
  }

  /** The first candidate whose probe passes, else libx264. A pinned encoder that fails throws so boot stops. */
  async function chooseEncoder(): Promise<EncoderChoice> {
    const requested = config.FFMPEG_ENCODER;
    const candidates = encoderCandidates(requested);
    if (!candidates.length) return { name: "libx264", requested, reason: "FFMPEG_ENCODER=libx264" };
    const failures: string[] = [];
    for (const enc of candidates) {
      const failure = await probeEncoder(enc);
      if (!failure) return { name: enc, requested, reason: `${enc} passed the boot probe${requested === "auto" ? "" : " (FFMPEG_ENCODER)"}` };
      failures.push(`${enc}: ${failure}`);
      if (requested !== "auto")
        throw new Error(
          `FFMPEG_ENCODER=${enc} cannot encode on this machine (${failure}). Give the container the GPU (docker-compose.gpu.yml) or set FFMPEG_ENCODER=auto.`,
        );
    }
    return { name: "libx264", requested, reason: `no hardware encoder available (${failures.join("; ")})` };
  }

  const run: MediaTools["run"] = (bin, args, opts) => {
    const tool = bin.split("/").pop()!;
    // which project/clip/job this belongs to comes from the job's async context (workers set it)
    const ids = () => {
      const { projectId, clipId, jobId } = llmContext();
      return { projectId, clipId, jobId };
    };
    return withSpan(`exec ${tool}`, { "process.command": bin, "process.args_count": args.length }, () => runRaw(bin, args, opts)).then(
      (res) => {
        log.debug({ ...ids(), tool, argv: loggableArgv(args) }, "exec");
        return res;
      },
      (err: unknown) => {
        log.debug({ ...ids(), tool, argv: loggableArgv(args), code: err instanceof CommandError ? err.code : undefined }, "exec failed");
        throw err;
      },
    );
  };

  const ffmpeg: MediaTools["ffmpeg"] = (args, opts) =>
    run(config.FFMPEG_PATH, ["-hide_banner", "-nostdin", "-y", ...threadedArgv(args, opts.threads)], {
      signal: opts.signal,
      onStderr: opts.onProgress
        ? (line) => {
            const t = parseProgressTime(line);
            if (t !== undefined) opts.onProgress!(t);
          }
        : undefined,
    });

  return {
    run,
    ffmpeg,
    encoder: () => encoder,
    videoEncodeArgs: (enc = encoder.name) => videoEncodeArgs(enc),
    ytdlpProxies: () => ytdlpPool.snapshot(),
    async ytdlp(args, opts) {
      const cookies = config.YTDLP_COOKIES_FILE ? ["--cookies", config.YTDLP_COOKIES_FILE] : [];
      // YouTube n-sig / PO tokens: eval already passes this; ingest and issue-report must too
      const js = args.includes("--js-runtimes") ? [] : ["--js-runtimes", "node"];
      // progress goes to stdout and has no size bound: only a caller that reads it line by line asks for it
      const progress = opts?.onStdout || args.includes("--progress") ? [] : ["--no-progress"];
      const prefix = [...js, ...cookies, ...progress];
      if (args.includes("--proxy") || ytdlpPool.size === 0) {
        return { ...(await run(config.YTDLP_PATH, [...prefix, ...args], opts)), proxyId: args.includes("--proxy") ? "explicit" : "direct" };
      }
      const { value, id } = await ytdlpPool.run(
        (choice, signal) => run(config.YTDLP_PATH, [...choice.args, ...prefix, ...args], { ...opts, signal }),
        opts?.signal,
        opts?.sections ? { accept: ffmpegCanUse } : undefined,
      );
      return { ...value, proxyId: id };
    },

    async ffprobe(file) {
      const { stdout } = await run(config.FFPROBE_PATH, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
      return probeInfo(JSON.parse(stdout) as Parameters<typeof probeInfo>[0]);
    },

    async extractAudio(input, output, signal, span) {
      // -ss before -i seeks the input (exact for audio, and fast on a long file); -t after it bounds the output
      const from = span && span.fromSec > 0 ? ["-ss", span.fromSec.toFixed(3)] : [];
      const until = span?.durationSec != null ? ["-t", span.durationSec.toFixed(3)] : [];
      await ffmpeg([...from, "-i", input, "-vn", ...until, "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", output], { signal, threads: "light" });
    },

    async segmentAudio(input, outPattern, chunkSeconds, signal) {
      await ffmpeg(["-i", input, "-f", "segment", "-segment_time", String(chunkSeconds), "-c", "copy", "-reset_timestamps", "1", outPattern], {
        signal,
        threads: "light",
      });
    },

    async detectScenes(input, { floor = 0.1, signal, range, threads }) {
      // per-frame scene scores on a small copy (fast, and plenty for shot changes), then adaptive
      // peak picking: fixed thresholds miss every cut in dark or low-contrast footage (see scenes.ts).
      // Input seeking (-ss before -i) restarts the output clock at 0, so a range's times are range-relative.
      const lines: string[] = [];
      const seek = range ? ["-ss", range.start.toFixed(3), "-t", range.duration.toFixed(3)] : [];
      try {
        await run(
          config.FFMPEG_PATH,
          [
            "-hide_banner",
            "-nostdin",
            ...sceneScanThreadArgs(threads),
            ...seek,
            "-i",
            input,
            "-an",
            "-vf",
            "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score",
            "-f",
            "null",
            "-",
          ],
          {
            signal,
            onStderr: (line) => {
              if (line.includes("pts_time:") || line.includes("scene_score=")) lines.push(line);
            },
          },
        );
      } catch (err) {
        // never `[]` for a failure: an empty list is stored as "the detector ran and found no cuts". The caller decides
        // what a failed decode means (a pipeline step records it and retries; a render carries on without cuts).
        if (signal?.aborted) throw err;
        log.warn({ err }, "scene detection failed");
        throw new Error(`Shot-change detection failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`.slice(0, 300), { cause: err });
      }
      const { times, scores } = parseSceneScores(lines);
      return pickSceneCuts(times, scores, { floor });
    },

    async check() {
      const errors: string[] = [];
      for (const [label, bin, args] of [
        ["FFMPEG_PATH", config.FFMPEG_PATH, ["-version"]],
        ["FFPROBE_PATH", config.FFPROBE_PATH, ["-version"]],
        ["YTDLP_PATH", config.YTDLP_PATH, ["--version"]],
      ] as const) {
        try {
          await execFileAsync(bin, [...args], { timeout: 15_000 });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
          errors.push(`${label}: cannot execute "${bin}" (${code}). Install it or point ${label} at the binary.`);
        }
      }
      if (errors.length) throw new Error(errors.join("\n"));
      // one decision per boot, with its reason; every encode's argv is on the debug "exec" line
      encoder = await chooseEncoder();
      log.info({ encoder: encoder.name, requested: encoder.requested, reason: encoder.reason }, "video encoder");
    },
  };
}
