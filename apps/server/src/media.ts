import { spawn, execFile } from "node:child_process";
import { llmContext } from "./ai/trace.js";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { withSpan } from "./otel.js";
import type { Logger } from "./log.js";
import { parseSceneScores, pickSceneCuts } from "./pipeline/scenes.js";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  signal?: AbortSignal;
  onStderr?: (line: string) => void;
  cwd?: string;
}
export interface ProbeInfo {
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  fps?: number;
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

/** Wrapper around the external media binaries (ffmpeg, ffprobe, yt-dlp). */
export interface MediaTools {
  run(bin: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  ffmpeg(args: string[], opts?: { signal?: AbortSignal; onProgress?: (sec: number) => void }): Promise<RunResult>;
  ffprobe(file: string): Promise<ProbeInfo>;
  ytdlp(args: string[], opts?: RunOptions): Promise<RunResult>;
  extractAudio(input: string, output: string, signal?: AbortSignal): Promise<void>;
  segmentAudio(input: string, outPattern: string, chunkSeconds: number, signal?: AbortSignal): Promise<void>;
  /** Shot cuts (seconds). `floor` = minimum scene score; cuts must also stand out from local motion. */
  detectScenes(input: string, floor?: number, signal?: AbortSignal): Promise<number[]>;
  /** Verifies every binary executes. */
  check(): Promise<void>;
}

/** Parses "time=00:01:23.45" from ffmpeg progress lines to seconds. */
export function parseProgressTime(line: string): number | undefined {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function runRaw(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal: opts.signal, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (opts.onStderr) {
        partial += s;
        const lines = partial.split(/\r?\n|\r/);
        partial = lines.pop() ?? "";
        for (const l of lines) opts.onStderr(l);
      }
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
    ytdlp: (args, opts) => run(config.YTDLP_PATH, [...(config.YTDLP_PROXY ? ["--proxy", config.YTDLP_PROXY] : []), ...(config.YTDLP_COOKIES_FILE ? ["--cookies", config.YTDLP_COOKIES_FILE] : []), ...args], opts),

    async ffprobe(file) {
      const { stdout } = await run(config.FFPROBE_PATH, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
      const json = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; r_frame_rate?: string }>;
      };
      const video = json.streams?.find((s) => s.codec_type === "video");
      const audio = json.streams?.find((s) => s.codec_type === "audio");
      const duration = Number(json.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
      let fps: number | undefined;
      if (video?.r_frame_rate) {
        const [n, d] = video.r_frame_rate.split("/").map(Number);
        if (n && d) fps = n / d;
      }
      return { durationSec: duration, width: video?.width, height: video?.height, hasAudio: !!audio, fps };
    },

    async extractAudio(input, output, signal) {
      await ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", output], { signal });
    },

    async segmentAudio(input, outPattern, chunkSeconds, signal) {
      await ffmpeg(["-i", input, "-f", "segment", "-segment_time", String(chunkSeconds), "-c", "copy", "-reset_timestamps", "1", outPattern], { signal });
    },

    async detectScenes(input, floor = 0.1, signal) {
      // per-frame scene scores on a small copy (fast, and plenty for shot changes), then adaptive
      // peak picking: fixed thresholds miss every cut in dark or low-contrast footage (see scenes.ts)
      const lines: string[] = [];
      try {
        await run(
          config.FFMPEG_PATH,
          ["-hide_banner", "-nostdin", "-i", input, "-an", "-vf", "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"],
          {
            signal,
            onStderr: (line) => {
              if (line.includes("pts_time:") || line.includes("scene_score=")) lines.push(line);
            },
          },
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        log.warn({ err }, "scene detection failed, continuing without scene cuts");
        return [];
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
    },
  };
}
