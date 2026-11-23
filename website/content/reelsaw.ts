import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import type { FeatureKey } from "./types";

export const CHECKED = "2026-10-24";

/** Reelsaw's column of every comparison table. Keep claims to what the README documents. */
export const FEATURES: { key: FeatureKey; label: string; reelsaw: string }[] = [
  {
    key: "local",
    label: t(msg`Runs fully local, no API keys`),
    reelsaw: t(
      msg`Yes, and it is the installer's default: Ollama for the language model, a local Whisper for transcription, on-device alignment and face detection. Nothing leaves the machine`,
    ),
  },
  {
    key: "providers",
    label: t(msg`Model providers`),
    reelsaw: t(
      msg`Any, for each of the three models separately: OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, Vercel AI Gateway, OpenCode, Ollama, vLLM, LM Studio or any OpenAI-compatible server. No vendor is baked in; admins switch at runtime`,
    ),
  },
  {
    key: "entry",
    label: t(msg`Entry price`),
    reelsaw: t(
      msg`$0 self-hosted (AGPL-3.0; you supply the machine and, if you want cloud models, the keys). Hosted at app.reelsaw.com: Free, then $12, $29 or $59 a month`,
    ),
  },
  {
    key: "free",
    label: t(msg`Free tier`),
    reelsaw: t(msg`Self-hosted: everything, no plan, no meter. Hosted: your first video free up to 60 minutes, then 20 minutes a month`),
  },
  { key: "watermark", label: t(msg`Watermark`), reelsaw: t(msg`Never on your own install (the software is yours). Hosted: on the Free plan only`) },
  { key: "openSource", label: t(msg`Open source`), reelsaw: t(msg`Yes, AGPL-3.0, pure TypeScript`) },
  { key: "selfHost", label: t(msg`Self-hostable`), reelsaw: t(msg`Yes: Docker Compose, one-command installer for macOS, Linux and Windows`) },
  {
    key: "moments",
    label: t(msg`AI moment detection`),
    reelsaw: t(msg`Yes: map, pool, rank with pairwise comparison; any language model, optional separate judge model`),
  },
  {
    key: "reframe",
    label: t(msg`Face-tracked 9:16 reframing`),
    reelsaw: t(
      msg`Yes: face, split, stack and fit per shot cut; webcam-tile stacks; crowds shown whole; phone clips between bars cropped to the picture; shots without a face follow their moving subject; hand-set crops; one clip's framing for the whole project; renders 9:16, 4:5, 1:1 or 16:9. YuNet face detector with landmarks and face tracking, on the CPU`,
    ),
  },
  {
    key: "captions",
    label: t(msg`Word-level captions`),
    reelsaw: t(
      msg`Yes: karaoke highlight, AI-picked key words, boxed or outlined, fonts your instance admin uploads, drag positions on a live preview, optional punch-in zooms on the key words; every script the transcriber takes, from Hindi and Thai to Japanese and Arabic`,
    ),
  },
  {
    key: "fillers",
    label: t(msg`Filler and false-start removal`),
    reelsaw: t(msg`Yes, for English: jump cuts located by forced alignment, each one reviewable`),
  },
  { key: "dubbing", label: t(msg`AI dubbing / translation`), reelsaw: t(msg`No`) },
  {
    key: "publishing",
    label: t(msg`Direct social publishing`),
    reelsaw: t(
      msg`No. Export zip with paste-ready text, a YouTube Data API body and a TikTok post body per clip, plus share links a scheduler (Buffer, Metricool) can fetch`,
    ),
  },
  {
    key: "agents",
    label: t(msg`Agent and API access`),
    reelsaw: t(msg`MCP server (Streamable HTTP, OAuth optional), signed webhooks and an operator CLI, on every plan including hosted Free`),
  },
  { key: "cap", label: t(msg`Usage cap`), reelsaw: t(msg`None self-hosted. Hosted plans meter minutes of source video per month, never per-clip credits`) },
  { key: "accounts", label: t(msg`Accounts and teams`), reelsaw: t(msg`Multi-user with admin approval, sign-up rules, per-user quotas and usage`) },
];

export const REELSAW_COST = {
  heading: t(msg`What Reelsaw costs for the same job`),
  paragraphs: [
    t(
      msg`The software is free under the AGPL-3.0. Self-hosted, what you pay for is the machine it runs on and, only if you choose cloud models, the per-call price of those models. If you would rather not run a machine, the hosted service at app.reelsaw.com runs the same code: a Free plan (first video free up to 60 minutes, then 20 minutes a month, with a watermark; a longer video gets its start clipped and the rest when you upgrade), then Starter ($12/mo, 100 minutes), Creator ($29/mo, 300 minutes) and Pro ($59/mo, 750 minutes), metered in minutes of source video and never per clip.`,
    ),
    t(
      msg`Fully local: Ollama for the language model and Speaches (Whisper) for transcription. The installer picks a model by GPU memory or RAM (qwen2.5:14b with 24 GB of RAM or a 12 GB GPU, qwen2.5:7b from 12 GB, gemma3:4b below that), reuses one Ollama already has, and puts both on an NVIDIA GPU when there is one. Nothing leaves the box and there is no per-minute cost at all.`,
    ),
    t(
      msg`With cloud models: set OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, OpenCode or any OpenAI-compatible endpoint as a provider:model string and you pay that vendor's metered price for transcription minutes and a few thousand tokens of selection per video. There is no Reelsaw margin on top.`,
    ),
  ],
};
