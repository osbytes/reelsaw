import type { FeatureKey } from "./types";

export const CHECKED = "2026-10-18";

/** Reelsaw's column of every comparison table. Keep claims to what the README documents. */
export const FEATURES: { key: FeatureKey; label: string; reelsaw: string }[] = [
  { key: "local", label: "Runs fully local, no API keys", reelsaw: "Yes, and it is the installer's default: Ollama for the language model, a local Whisper for transcription, on-device alignment and face detection. Nothing leaves the machine" },
  { key: "providers", label: "Model providers", reelsaw: "Any, for each of the three models separately: OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, Vercel AI Gateway, Ollama, vLLM, LM Studio or any OpenAI-compatible server. No vendor is baked in; admins switch at runtime" },
  { key: "entry", label: "Entry price", reelsaw: "$0. AGPL-3.0 software; you supply the machine and, if you want cloud models, the API keys" },
  { key: "free", label: "Free tier", reelsaw: "Everything, with no plan and no meter" },
  { key: "watermark", label: "Watermark", reelsaw: "Never" },
  { key: "openSource", label: "Open source", reelsaw: "Yes, AGPL-3.0, pure TypeScript" },
  { key: "selfHost", label: "Self-hostable", reelsaw: "Yes: Docker Compose, one-command installer for macOS, Linux and Windows" },
  { key: "moments", label: "AI moment detection", reelsaw: "Yes: map, pool, rank with pairwise comparison; any language model, optional separate judge model" },
  { key: "reframe", label: "Face-tracked 9:16 reframing", reelsaw: "Yes: face, split, stack and fit layouts per segment; 1.2 MB UltraFace detector on the CPU" },
  { key: "captions", label: "Word-level captions", reelsaw: "Yes: karaoke highlight, AI-picked key words, boxed or outlined, drag positions on a live preview" },
  { key: "fillers", label: "Filler and false-start removal", reelsaw: "Yes: jump cuts located by forced alignment, each one reviewable" },
  { key: "dubbing", label: "AI dubbing / translation", reelsaw: "No" },
  { key: "publishing", label: "Direct social publishing", reelsaw: "No. Export zip with paste-ready text, a YouTube Data API body and a TikTok post body per clip" },
  { key: "agents", label: "Agent and API access", reelsaw: "MCP server (Streamable HTTP, OAuth optional) and an operator CLI" },
  { key: "cap", label: "Usage cap", reelsaw: "None" },
  { key: "accounts", label: "Accounts and teams", reelsaw: "Multi-user with admin approval, per-user quotas and usage" },
];

export const REELSAW_COST = {
  heading: "What Reelsaw costs for the same job",
  paragraphs: [
    "The software is free under the AGPL-3.0 and there is no hosted plan to upsell you to. What you pay for is the machine it runs on and, only if you choose cloud models, the per-call price of those models.",
    "Fully local: Ollama for the language model and Speaches (Whisper) for transcription. The installer picks a model by RAM (qwen2.5:14b on 24 GB or more, qwen2.5:7b from 12 GB, gemma3:4b below that). Nothing leaves the box and there is no per-minute cost at all.",
    "With cloud models: set OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI or any OpenAI-compatible endpoint as a provider:model string and you pay that vendor's metered price for transcription minutes and a few thousand tokens of selection per video. There is no Reelsaw margin on top.",
  ],
};
