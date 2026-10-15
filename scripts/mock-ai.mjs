// Deterministic OpenAI-compatible mock for local end-to-end testing: node scripts/mock-ai.mjs
// Minimal OpenAI-compatible mock: /v1/audio/transcriptions (word timestamps) + /v1/chat/completions (JSON clips)
import http from "node:http";
const PORT = Number(process.env.MOCK_PORT ?? 4545);
const calls = [];

function wordsFor(durationSec) {
  // one word every 0.4s, sentence every 8 words, deterministic content
  const vocab = ["this", "is", "a", "test", "of", "the", "clip", "pipeline", "and", "it", "works", "great", "today", "friends", "really", "well"];
  const words = [];
  let t = 0.2, i = 0;
  while (t < durationSec - 0.5) {
    const w = vocab[i % vocab.length];
    const end = Math.min(durationSec, t + 0.35);
    const last = (i + 1) % 8 === 0;
    words.push({ word: w + (last ? "." : ""), start: Number(t.toFixed(2)), end: Number(end.toFixed(2)) });
    t += 0.4; i++;
  }
  return words;
}

http.createServer(async (req, res) => {
  let body = Buffer.alloc(0);
  for await (const chunk of req) body = Buffer.concat([body, chunk]);
  calls.push({ url: req.url, bytes: body.length });
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/v1/audio/transcriptions")) {
    const durationSec = Number(process.env.MOCK_CHUNK_SECONDS ?? 90);
    const words = wordsFor(durationSec);
    res.end(JSON.stringify({ task: "transcribe", language: "english", duration: durationSec, text: words.map((w) => w.word).join(" "), words }));
    return;
  }
  if (req.url?.startsWith("/v1/chat/completions")) {
    const parsed = JSON.parse(body.toString());
    const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const lines = [...content.matchAll(/\[(\d\d):(\d\d\.\d) - (\d\d):(\d\d\.\d)\]/g)].map((m) => ({ s: Number(m[1]) * 60 + Number(m[2]), e: Number(m[3]) * 60 + Number(m[4]) }));
    const clips = [];
    // pick windows of ~25s from line boundaries
    let i = 0;
    while (i < lines.length && clips.length < 3) {
      const start = lines[i].s;
      let j = i;
      while (j < lines.length && lines[j].e - start < 25) j++;
      if (j >= lines.length) break;
      clips.push({ title: `Mock clip ${clips.length + 1}`, hook: `WAIT FOR IT ${clips.length + 1}`, startSec: start, endSec: lines[j].e, score: 90 - clips.length * 7, reasoning: "Deterministic mock pick.", hashtags: ["test", "mock"] });
      i = j + 1;
    }
    const payload = { clips };
    const usesTool = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    const msg = usesTool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: parsed.tools[0].function.name, arguments: JSON.stringify(payload) } }] }
      : { role: "assistant", content: JSON.stringify(payload) };
    res.end(JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion", created: Date.now() / 1000, model: parsed.model, choices: [{ index: 0, message: msg, finish_reason: usesTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    return;
  }
  if (req.url === "/calls") { res.end(JSON.stringify(calls)); return; }
  res.statusCode = 404; res.end(JSON.stringify({ error: "not mocked: " + req.url }));
}).listen(PORT, () => console.log("mock ai on", PORT));
