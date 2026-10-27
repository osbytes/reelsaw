import { spawn, execFile } from "node:child_process";
import { llmContext } from "./ai/trace.js";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { withSpan } from "./otel.js";
import type { Logger } from "./log.js";
import { parseSceneScores, pickSceneCuts } from "./pipeline/scenes.js";
import { createYtdlpProxyPool, parseYtdlpProxies, type ProxySnapshot } from "./ytdlp-proxy.js";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  signal?: AbortSignal;
  /** each complete stderr line (split on \n or \r, so carriage-return progress bars arrive as lines) */
  onStderr?: (line: string) => void;
  /** each complete stdout line; yt-dlp writes its `[download]` progress here, not to stderr */
  onStdout?: (line: string) => void;
  cwd?: string;
}
export interface ProbeInfo {
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  fps?: number;
  /** frames in the first video stream when the container says (an animated GIF or WebP has more than one) */
  frames?: number;
}

export class CommandError extends Error {
  constructor(
    public cmd: string,
    public code: number | null,
    public stderr: string,
  ) {
    // lead with the lines that say what went wrong; ffmpeg prints a long banner first
    const key = stderr
      .split("\n")
      .filter((l) => /error|invalid|fail|cannot|no such|unable|not found|unknown/i.test(l))
      .slice(-6)
      .join("\n");
    super(`${cmd} exited with ${code}: ${key ? `${key}\n--- tail ---\n` : ""}${stderr.slice(-1200)}`);
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
 * Decoder/encoder threads plus the two filtergraph pools. `-threads` does not apply to filters;
 * those default to the CPU count, and a 32-core host running several jump-cut graphs then races
 * inside `scale` (`Failed to configure output pad` / EAGAIN on reinit). Filtergraph threads stay at
 * 1: x264/NVENC take the encode cores, and overlay/scale reinit is not safe to parallelise.
 */
export function ffmpegThreadArgs(encodeThreads: number): string[] {
  const t = String(Math.max(1, encodeThreads));
  return ["-threads", t, "-filter_threads", "1", "-filter_complex_threads", "1"];
}

/** Rawvideo-to-pipe sampling: frame-threaded rawvideo fails to open (`ff_frame_thread_encoder_init`). */
export const ffmpegPipeThreads = ["-threads", "1", "-filter_threads", "1"] as const;

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
  ffmpeg(args: string[], opts?: { signal?: AbortSignal; onProgress?: (sec: number) => void }): Promise<RunResult>;
  /** the H.264 encoder renders use, decided by `check()` from FFMPEG_ENCODER and a probe */
  encoder(): EncoderChoice;
  /** `-c:v …` for the encoder in use (or a named one, for a software retry after a hardware failure) */
  videoEncodeArgs(encoder?: VideoEncoder): string[];
  ffprobe(file: string): Promise<ProbeInfo>;
  /** `proxyId`: the YTDLP_PROXY candidate that served it, "direct" with no pool, "explicit" when `args` carry `--proxy` */
  ytdlp(args: string[], opts?: RunOptions): Promise<RunResult & { proxyId: string }>;
  /** operator-ranked yt-dlp egress candidates and their circuit state (`reelsaw ytdlp-proxies`) */
  ytdlpProxies(): { next: string | null; candidates: ProxySnapshot[] };
  extractAudio(input: string, output: string, signal?: AbortSignal): Promise<void>;
  segmentAudio(input: string, outPattern: string, chunkSeconds: number, signal?: AbortSignal): Promise<void>;
  /** Shot cuts (seconds). `floor` = minimum scene score; cuts must also stand out from local motion. */
  /**
   * Shot-cut times in seconds. With `range`, only that stretch is decoded and the times are relative to
   * `range.start` (a clip's cuts on its own clock). Never throws: a failed detection is an empty list.
   */
  detectScenes(input: string, floor?: number, signal?: AbortSignal, range?: { start: number; duration: number }): Promise<number[]>;
  /** Verifies every binary executes. */
  check(): Promise<void>;
}

/** Parses "time=00:01:23.45" from ffmpeg progress lines to seconds. */
export function parseProgressTime(line: string): number | undefined {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Feeds complete lines (split on \n or \r) to `onLine`, buffering the unfinished tail across chunks. */
export function lineSplitter(onLine?: (line: string) => void): (chunk: string) => void {
  if (!onLine) return () => {};
  let partial = "";
  return (chunk) => {
    partial += chunk;
    const lines = partial.split(/\r?\n|\r/);
    partial = lines.pop() ?? "";
    for (const l of lines) onLine(l);
  };
}

function runRaw(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal: opts.signal, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const outLines = lineSplitter(opts.onStdout);
    const errLines = lineSplitter(opts.onStderr);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      outLines(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      errLines(s);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new CommandError(bin, code, stderr))));
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
      await execFileAsync(config.FFMPEG_PATH, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.2", "-frames:v", "3", "-pix_fmt", "yuv420p", ...videoEncodeArgs(enc), "-f", "null", "-"], { timeout: 20_000 });
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
      if (requested !== "auto") throw new Error(`FFMPEG_ENCODER=${enc} cannot encode on this machine (${failure}). Give the container the GPU (docker-compose.gpu.yml) or set FFMPEG_ENCODER=auto.`);
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

  const ffmpeg: MediaTools["ffmpeg"] = (args, opts = {}) =>
    run(config.FFMPEG_PATH, ["-hide_banner", "-nostdin", "-y", ...args], {
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
      const prefix = [...js, ...cookies];
      if (args.includes("--proxy") || ytdlpPool.size === 0) {
        return { ...(await run(config.YTDLP_PATH, [...prefix, ...args], opts)), proxyId: args.includes("--proxy") ? "explicit" : "direct" };
      }
      const { value, id } = await ytdlpPool.run((choice, signal) => run(config.YTDLP_PATH, [...choice.args, ...prefix, ...args], { ...opts, signal }), opts?.signal);
      return { ...value, proxyId: id };
    },

    async ffprobe(file) {
      const { stdout } = await run(config.FFPROBE_PATH, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
      const json = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; r_frame_rate?: string; nb_frames?: string }>;
      };
      const video = json.streams?.find((s) => s.codec_type === "video");
      const audio = json.streams?.find((s) => s.codec_type === "audio");
      const duration = Number(json.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
      let fps: number | undefined;
      if (video?.r_frame_rate) {
        const [n, d] = video.r_frame_rate.split("/").map(Number);
        if (n && d) fps = n / d;
      }
      return { durationSec: duration, width: video?.width, height: video?.height, hasAudio: !!audio, fps, ...(Number(video?.nb_frames) > 0 ? { frames: Number(video?.nb_frames) } : {}) };
    },

    async extractAudio(input, output, signal) {
      await ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", output], { signal });
    },

    async segmentAudio(input, outPattern, chunkSeconds, signal) {
      await ffmpeg(["-i", input, "-f", "segment", "-segment_time", String(chunkSeconds), "-c", "copy", "-reset_timestamps", "1", outPattern], { signal });
    },

    async detectScenes(input, floor = 0.1, signal, range) {
      // per-frame scene scores on a small copy (fast, and plenty for shot changes), then adaptive
      // peak picking: fixed thresholds miss every cut in dark or low-contrast footage (see scenes.ts).
      // Input seeking (-ss before -i) restarts the output clock at 0, so a range's times are range-relative.
      const lines: string[] = [];
      const seek = range ? ["-ss", range.start.toFixed(3), "-t", range.duration.toFixed(3)] : [];
      try {
        await run(
          config.FFMPEG_PATH,
          ["-hide_banner", "-nostdin", ...ffmpegPipeThreads, ...seek, "-i", input, "-an", "-vf", "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"],
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
