import { spawn } from "node:child_process";
import { CommandError, decodeThreadArgs } from "../media.js";
import { VAD_SR } from "./vad.js";

/** 16 kHz mono float PCM of a clip's audio (VAD input, and matching a section to the source). */
export function clipPcm(ffmpegPath: string, source: string, start: number, duration: number, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...decodeThreadArgs(1), // audio only
        "-ss",
        start.toFixed(3),
        "-t",
        duration.toFixed(3),
        "-i",
        source,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(VAD_SR),
        "-f",
        "f32le",
        "pipe:1",
      ],
      { signal },
    );
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.on("error", reject);
    p.on("close", (code, sig) => {
      if (code !== 0) return reject(new CommandError("ffmpeg (clip audio)", code, "", sig));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
    });
  });
}
