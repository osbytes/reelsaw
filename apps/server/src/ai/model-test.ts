/**
 * "Does this model work here?", one real call: Settings → Models Test, the `test_model` MCP tool and
 * `reelsaw test-model` all run this. A language model must answer a one-word prompt; a transcription model
 * re-runs the word-timestamp test clip (ai/word-timestamps.ts), and the answer carries what it heard.
 */
import { generateText } from "ai";
import type { AiService } from "./registry.js";
import type { WordTimestampVerdict } from "./word-timestamps.js";

export type ModelTestResult =
  | { ok: true; ms: number; reply: string | null; wordTimestamps: WordTimestampVerdict | null }
  | { ok: false; ms: number; error: string; wordTimestamps: WordTimestampVerdict | null };

export async function testModel(ai: AiService, input: { kind: "language" | "transcription"; id: string }): Promise<ModelTestResult> {
  const t0 = Date.now();
  const verdict = async () => (input.kind === "transcription" ? ((await ai.wordTimestampVerdict(input.id).catch(() => undefined)) ?? null) : null);
  try {
    await ai.verify(input.kind, input.id, { fresh: true });
    if (input.kind === "language") {
      const r = await generateText({
        model: await ai.languageModel(input.id),
        prompt: "Reply with the single word: ready",
        maxOutputTokens: 8,
        abortSignal: AbortSignal.timeout(60_000),
        telemetry: { functionId: "admin.models.test" },
      });
      return { ok: true, ms: Date.now() - t0, reply: r.text.trim().slice(0, 40), wordTimestamps: null };
    }
    const v = await verdict();
    return { ok: true, ms: Date.now() - t0, reply: v?.text.slice(0, 40) ?? null, wordTimestamps: v };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: (err as Error).message, wordTimestamps: await verdict() };
  }
}
