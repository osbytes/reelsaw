import type { FeatureKey } from "./types";

export const CHECKED = "2026-10-24";

/** Reelsaw's column of every comparison table. Keep claims to what the README documents. */
export const FEATURES: { key: FeatureKey; label: string; reelsaw: string }[] = [
  {
    key: "local",
    label: "Runs fully local, no API keys",
    reelsaw:
      "Yes, and it is the installer's default: Ollama for the language model, a local Whisper for transcription, on-device alignment and face detection. Nothing leaves the machine",
  },
  {
    key: "providers",
    label: "Model providers",
    reelsaw:
      "Any, for each of the three models separately: OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, Vercel AI Gateway, Ollama, vLLM, LM Studio or any OpenAI-compatible server. No vendor is baked in; admins switch at runtime",
  },
  {
    key: "entry",
    label: "Entry price",
    reelsaw:
      "$0 self-hosted (AGPL-3.0; you supply the machine and, if you want cloud models, the keys). Hosted at app.reelsaw.com: Free, then $12, $29 or $59 a month",
  },
  {
    key: "free",
    label: "Free tier",
    reelsaw: "Self-hosted: everything, no plan, no meter. Hosted: your first video free up to 60 minutes, then 20 minutes a month",
  },
  { key: "watermark", label: "Watermark", reelsaw: "Never on your own install (the software is yours). Hosted: on the Free plan only" },
  { key: "openSource", label: "Open source", reelsaw: "Yes, AGPL-3.0, pure TypeScript" },
  { key: "selfHost", label: "Self-hostable", reelsaw: "Yes: Docker Compose, one-command installer for macOS, Linux and Windows" },
  { key: "moments", label: "AI moment detection", reelsaw: "Yes: map, pool, rank with pairwise comparison; any language model, optional separate judge model" },
  {
    key: "reframe",
    label: "Face-tracked 9:16 reframing",
    reelsaw:
      "Yes: face, split, stack and fit per shot cut; webcam-tile stacks; crowds shown whole; hand-set crops; one clip's framing for the whole project. 1.2 MB UltraFace on the CPU",
  },
  {
    key: "captions",
    label: "Word-level captions",
    reelsaw: "Yes: karaoke highlight, AI-picked key words, boxed or outlined, drag positions on a live preview",
  },
  { key: "fillers", label: "Filler and false-start removal", reelsaw: "Yes: jump cuts located by forced alignment, each one reviewable" },
  { key: "dubbing", label: "AI dubbing / translation", reelsaw: "No" },
  {
    key: "publishing",
    label: "Direct social publishing",
    reelsaw:
      "No. Export zip with paste-ready text, a YouTube Data API body and a TikTok post body per clip, plus share links a scheduler (Buffer, Metricool) can fetch",
  },
  {
    key: "agents",
    label: "Agent and API access",
    reelsaw: "MCP server (Streamable HTTP, OAuth optional), signed webhooks and an operator CLI, on every plan including hosted Free",
  },
  { key: "cap", label: "Usage cap", reelsaw: "None self-hosted. Hosted plans meter minutes of source video per month, never per-clip credits" },
  { key: "accounts", label: "Accounts and teams", reelsaw: "Multi-user with admin approval, per-user quotas and usage" },
];

export const REELSAW_COST = {
  heading: "What Reelsaw costs for the same job",
  paragraphs: [
    "The software is free under the AGPL-3.0. Self-hosted, what you pay for is the machine it runs on and, only if you choose cloud models, the per-call price of those models. If you would rather not run a machine, the hosted service at app.reelsaw.com runs the same code: a Free plan (first video free up to 60 minutes, then 20 minutes a month, with a watermark), then Starter ($12/mo, 100 minutes), Creator ($29/mo, 300 minutes) and Pro ($59/mo, 750 minutes), metered in minutes of source video and never per clip.",
    "Fully local: Ollama for the language model and Speaches (Whisper) for transcription. The installer picks a model by GPU memory or RAM (qwen2.5:14b with 24 GB of RAM or a 12 GB GPU, qwen2.5:7b from 12 GB, gemma3:4b below that), reuses one Ollama already has, and puts both on an NVIDIA GPU when there is one. Nothing leaves the box and there is no per-minute cost at all.",
    "With cloud models: set OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI or any OpenAI-compatible endpoint as a provider:model string and you pay that vendor's metered price for transcription minutes and a few thousand tokens of selection per video. There is no Reelsaw margin on top.",
  ],
};
