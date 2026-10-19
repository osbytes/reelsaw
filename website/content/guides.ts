import { CHECKED } from "./reelsaw";
import type { Guide } from "./types";

export const GUIDES: Guide[] = [
  {
    slug: "free-ai-clip-generator-no-watermark",
    metaTitle: "Free AI clip generator with no watermark (self-hosted)",
    metaDescription:
      "Most free AI clip generators watermark your clips until you pay. Reelsaw is open-source software you run yourself, so clips are free and never watermarked. How each tool handles watermarks, checked " +
      CHECKED +
      ".",
    h1: "A free AI clip generator with no watermark, and why that is rare",
    intro: [
      "Every hosted clipping service pays for GPUs, storage and bandwidth on your behalf, so its free tier has to push you toward a plan. The watermark is how: it makes the free clips unusable in public while still showing you the product works.",
      "The structural exception is software you run yourself. Reelsaw is an open-source AI clipper that installs with one command, has no plans, and never writes a watermark, because there is nothing to upsell.",
    ],
    sections: [
      {
        heading: "Why every free clip generator adds a watermark",
        paragraphs: [
          "A clipping run costs the vendor real money: transcription minutes, a language-model call to pick moments, face detection and a video render. A free plan that produced clean clips would lose money on every user who never converts. So free plans do one or more of: watermark the output, cap the minutes, lower the resolution, or delete the clips after a few days.",
        ],
      },
      {
        heading: "The structural exception: software you run yourself",
        paragraphs: [
          "When the software runs on your machine, there is no vendor paying for compute, so there is no reason to watermark. Reelsaw transcribes, picks moments, reframes to 9:16 and burns in captions using your CPU and either local models (Ollama, Whisper) or cloud models you hold the keys for.",
          "The install is one command on macOS, Linux or Windows. It needs Docker and about 10 GB of disk; the installer picks a language model sized to your RAM and waits until the app answers.",
        ],
      },
      {
        heading: "How the main tools handle watermarks",
        table: {
          columns: ["Tool", "Free tier", "Cheapest way to lose the watermark"],
          rows: [
            ["Reelsaw", "Everything, self-hosted", "There is none. $0"],
            ["OpenShorts", "Self-hosted: none. Cloud: 20 min/mo with watermark", "Self-host ($0) or Cloud from $12/mo"],
            ["Opus Clip", "Captions with watermark, exports expire after 3 days", "Starter, $15/mo"],
            ["Vizard", "60 upload min/mo, 720p, 3-day storage; 'No watermark' is a Creator feature", "Creator, priced by yearly credit bundle"],
            ["2short.ai", "30 min of analysis/mo", "Page says 'goodbye to watermarks' without a plan; Lite is $9.90/mo"],
            ["quso.ai", "75 credits/mo, 720p, 7-day retention", "Watermark not mentioned; Lite is $29/mo"],
            ["Submagic", "No free plan", "Starter, $19/mo or $12/mo yearly, no watermark on any plan"],
            ["Klap", "No free plan listed", "Basic, $14/mo billed yearly; watermark not stated"],
          ],
        },
        paragraphs: ["Prices and limits read from each vendor's public pricing page on " + CHECKED + ". Vendors change plans without notice; verify before you buy."],
      },
      {
        heading: "What you trade for the self-hosted zero",
        bullets: [
          "Hardware: Docker, about 10 GB of disk, 8 GB of RAM with a hosted provider or more for a local language model (the installer checks the machine and picks qwen2.5:14b with 24 GB of RAM or a 12 GB GPU, qwen2.5:7b from 12 GB, gemma3:4b below; it asks before it installs anything).",
          "Time: a fully local run on a CPU is slower than a vendor's GPU. Cloud transcription and selection models bring that back down; you pay those vendors directly, with no markup.",
          "Setup: one command, then an account that becomes the admin. Updates are a Docker pull.",
          "No social publishing: Reelsaw exports a zip with a paste-ready caption, a YouTube Data API body and a TikTok post body per clip, and leaves posting to you or an agent.",
        ],
      },
    ],
    faqs: [
      { q: "Is there a free AI clip generator without a watermark?", a: "Yes: self-hosted software. Reelsaw is open source under the AGPL-3.0, installs with one command, and never watermarks because it has no paid tier. OpenShorts, also open source, is watermark-free when self-hosted." },
      { q: "Do any hosted free plans skip the watermark?", a: "Among the tools checked on " + CHECKED + ", Submagic lists no watermark on any plan but has no free plan; 2short.ai makes a general 'no watermarks' claim without tying it to a plan. Opus Clip and OpenShorts Cloud watermark their free tiers; Vizard lists watermark removal as a paid feature." },
      { q: "How do I remove a watermark from a clip I already made?", a: "Re-render it from the source without the watermark. Cropping or blurring a watermark lowers quality and usually breaks the tool's terms; running the source through Reelsaw gives you a clean clip from the original video." },
    ],
    sources: [
      { href: "https://www.opus.pro/pricing", label: "Opus Clip pricing" },
      { href: "https://vizard.ai/pricing", label: "Vizard pricing" },
      { href: "https://2short.ai/pricing", label: "2short.ai pricing" },
      { href: "https://quso.ai/pricing", label: "quso.ai pricing" },
      { href: "https://www.submagic.co/pricing", label: "Submagic pricing" },
      { href: "https://klap.app/pricing", label: "Klap pricing" },
      { href: "https://github.com/mutonby/openshorts", label: "OpenShorts README" },
    ],
  },
  {
    slug: "open-source-video-clipper",
    metaTitle: "Open-source AI video clippers: what the licence actually gets you",
    metaDescription:
      "Comparing open-source AI video clippers (Reelsaw, AGPL-3.0, TypeScript; OpenShorts, MIT, Python): what to check in the licence, the local-only path, the agent surface and the pipeline before you commit.",
    h1: "Open-source video clippers: what 'open source' actually gets you",
    intro: [
      "'Open source' on a clipping tool can mean anything from a fully local pipeline to a thin client that still calls one vendor's API. The question that matters is whether you can run every step on your own hardware, with the models you choose. Reelsaw was built to answer yes to both; OpenShorts, the other open-source clipper with traction, answers yes to the first only if you keep a Gemini key.",
      "This page lists what to check and how each project answers.",
    ],
    sections: [
      {
        heading: "Four things to check before you choose",
        bullets: [
          "Local-only path: can every model run on your hardware, or is one vendor still required for some step? That decides whether 'self-hosted' also means 'private' and 'free'. Reelsaw: yes, by default. OpenShorts: Gemini stays required for layout picking and silent videos.",
          "Provider choice: can you point each model at the vendor you want (or at a local server) without changing code? Reelsaw: every model is a provider:model string, switchable at runtime. OpenShorts: an OpenAI-compatible server for moment picking only.",
          "Licence: MIT lets anyone take the code private, including as a hosted service. AGPL-3.0 requires anyone who runs a modified version for others to publish their changes. Neither is wrong; they protect different people.",
          "Agent surface: an MCP server means Claude Code, Claude Desktop, Cursor or a script can drive the whole pipeline. Check whether it is plan-gated.",
          "Pipeline depth: how moments are chosen, whether filler cuts are verified, what the editor can override, and whether a crashed run resumes.",
        ],
      },
      {
        heading: "Reelsaw and OpenShorts, side by side",
        table: {
          columns: ["", "Reelsaw", "OpenShorts"],
          rows: [
            ["Fully local, no API keys", "Yes, the installer's default: Ollama, local Whisper, on-device alignment and face detection", "No: Gemini is still needed for layout picking and silent videos"],
            ["Language model", "Any: OpenAI, Anthropic, Google, Groq, Vercel AI Gateway, Ollama, vLLM, LM Studio or any OpenAI-compatible server; switched at runtime", "Gemini by default; any OpenAI-compatible server for moment picking only"],
            ["Transcription", "Any: Deepgram, AssemblyAI, OpenAI, Groq, or a local Whisper server (Speaches, CPU or CUDA)", "faster-whisper, optional Parakeet backend; GPU override"],
            ["GPU", "Compose override: faster-whisper on CUDA, Ollama in a container, NVENC encoding; detection models on the CPU", "Image build flag: faster-whisper on CUDA, NVENC encoding, detection models on CUDA"],
            ["Licence", "AGPL-3.0, whole repository", "MIT core; cloud/ directory under a commercial licence"],
            ["Stack", "TypeScript: Hono, tRPC, Drizzle, Postgres, pg-boss, React", "Python: FastAPI, faster-whisper, MediaPipe, YOLOv8; React frontend"],
            ["Moment selection", "Map, pool, rank: chunked at pauses, rubric scored as a median of k samples, pairwise top-10 with swapped positions, optional judge model", "Gemini picks 3 to 15 moments per video"],
            ["Reframing", "Face, split, stack, fit per segment; active-speaker following; per-section overrides in the editor", "Track, general, split, screencast modes picked per video"],
            ["Filler removal", "Yes, forced-alignment verified, each cut reviewable", "Not listed"],
            ["Editor", "Live 9:16 preview, multi-lane timeline, snapping, layout sections, transitions, intros and outros, undo", "Dashboard with per-video settings"],
            ["Agents", "MCP server (OAuth optional), operator CLI", "MCP server, REST API with webhooks, CLI, agent skill"],
            ["Beyond clipping", "Export zip with platform-ready metadata", "Dubbing, AI UGC videos, YouTube studio, direct publishing, hosted cloud"],
            ["Multi-user", "Accounts, admin approval, quotas, usage, runtime model switching", "Hosted accounts with API keys"],
            ["Durability", "Every stage is a Postgres job that checkpoints and resumes", "Not documented"],
          ],
        },
        paragraphs: ["Read from each project's README on " + CHECKED + ". Both move quickly; check the repositories for the current state."],
      },
      {
        heading: "Which one to pick",
        bullets: [
          "Pick Reelsaw for the core job and control over it: fully local by default with no API key, any provider for any model, selection you can audit, cuts you can review, per-segment framing, an editor, teams, and a pipeline that resumes after a crash.",
          "Pick OpenShorts for breadth around the job: dubbing, UGC generation, publishing, a hosted fallback and a bigger community.",
          "Pick either over a hosted plan if you clip long videos regularly or need the source to stay on your hardware.",
        ],
      },
    ],
    faqs: [
      { q: "Is there an open-source alternative to Opus Clip?", a: "Yes. Reelsaw (AGPL-3.0, TypeScript) and OpenShorts (MIT, Python) are both open-source AI clippers you can self-host with Docker Compose. Reelsaw runs with no API key at all and lets you pick any provider per model; OpenShorts keeps a Gemini dependency. See the Opus Clip comparison for a feature-by-feature table." },
      { q: "Does open source mean my video stays private?", a: "Only if every model can run locally. Reelsaw's installer sets up Ollama and a local Whisper so nothing leaves your machine; with cloud models, only audio (for transcription) or transcript text (for selection) is sent to the vendor you chose." },
      { q: "Can I modify Reelsaw and run it for my team?", a: "Yes. The AGPL-3.0 allows internal use and modification freely. If you offer a modified version to the public as a service, you must publish your changes." },
    ],
    sources: [
      { href: "https://github.com/osbytes/reelsaw#readme", label: "Reelsaw README" },
      { href: "https://github.com/mutonby/openshorts", label: "OpenShorts README" },
    ],
  },
  {
    slug: "youtube-to-shorts-converter",
    metaTitle: "YouTube to Shorts converter you run on your own machine",
    metaDescription:
      "Paste a YouTube link, get vertical Shorts with word-highlight captions, a hook and a YouTube Data API upload body, all rendered on your own hardware with open-source software. No credits, no watermark.",
    h1: "YouTube to Shorts converter you can run on your own machine",
    intro: [
      "A YouTube link is the most common input to a clipping tool, and the first thing hosted services charge for is the minutes in it. Reelsaw takes the same link and does the whole job on your hardware: fetch, transcribe, pick moments, reframe to 9:16, caption, and hand back clips with upload metadata.",
      "Use it on your own videos or ones you have the rights to clip.",
    ],
    sections: [
      {
        heading: "What happens after you paste the link",
        bullets: [
          "Ingest: yt-dlp fetches the video, ffprobe reads it, and the source is stored once so every later step can resume from it.",
          "Transcribe: audio is split into chunks and transcribed in parallel with word timestamps, then names are fixed from your vocabulary and fillers are cut with verified jump cuts.",
          "Pick: the transcript is chunked at long pauses, every standalone moment is scored on hook, value, flow and shareability, and the top picks are compared head-to-head. Optional focus: 'Find clips about pricing'.",
          "Reframe: a face detector picks face, split, stack or fit per segment; the crop follows whoever is speaking.",
          "Render: ffmpeg burns in karaoke captions and the hook, plus your intro and outro, in one encode. Clips stream into the workspace as they finish.",
        ],
      },
      {
        heading: "What you get back",
        bullets: [
          "Every clip as a 9:16 MP4 with its score, layout and a hook overlay.",
          "A paste-ready title, description, hashtags and caption per clip. Descriptions carry a timestamped link to the exact moment in the parent video.",
          "A YouTube Data API v3 videos.insert body per clip (private by default) and a TikTok Content Posting API body, so a script or agent can upload.",
          "A manifest and a CSV for the whole batch. The same through the MCP server, so an agent can run the loop end to end.",
        ],
      },
      {
        heading: "How it compares to hosted converters",
        table: {
          columns: ["", "Reelsaw", "Hosted converters (Opus Clip, Vizard, 2short, quso)"],
          rows: [
            ["Price", "$0 software; your hardware or your model keys", "Free tiers with watermarks, 720p or expiring exports; paid from about $10 to $29 a month"],
            ["Source length", "No limit beyond your disk", "Metered per minute or per credit; some cap export length"],
            ["Where the video goes", "Stays on your machine", "Uploaded to the vendor"],
            ["Automation", "MCP server and CLI on every install", "API or MCP on higher plans, where offered"],
            ["Publishing", "Export with API bodies; no built-in posting", "Built-in scheduling on most paid plans"],
          ],
        },
      },
    ],
    faqs: [
      { q: "Can Reelsaw download any YouTube video?", a: "It uses yt-dlp, which fetches public videos. Clip only content you own or have permission to use; YouTube's terms apply to downloading." },
      { q: "Does it upload the Shorts to YouTube for me?", a: "Not directly. Export all includes a YouTube Data API v3 videos.insert body per clip, set to private, so a script or an agent on the MCP server can upload with your credentials." },
      { q: "How long does a one-hour video take?", a: "It depends on the models. Cloud transcription of an hour takes a few minutes; fully local on a CPU with faster-whisper-small runs roughly in real time. Rendering is a few seconds per clip. Every stage checkpoints, so a restart resumes rather than starts over." },
    ],
    sources: [{ href: "https://github.com/osbytes/reelsaw#readme", label: "Reelsaw README: pipeline, export formats and MCP tools" }],
  },
  {
    slug: "podcast-to-shorts",
    metaTitle: "Podcast to shorts: two-speaker reframing, filler cuts, no meter",
    metaDescription:
      "Turn two-hour podcast episodes into vertical clips with split-screen reframing that follows the active speaker, filler and false-start cuts you can review, and no per-minute price. Open source, self-hosted.",
    h1: "Podcast to shorts without paying by the minute",
    intro: [
      "Podcasts are the worst case for per-minute pricing: long episodes, two or three faces, and a lot of 'um' between the good parts. Reelsaw was built around that shape: it chunks long transcripts without losing the middle, stacks speakers when it cannot pick one, and cuts fillers with cuts it has checked.",
    ],
    sections: [
      {
        heading: "Long episodes without losing the middle",
        paragraphs: [
          "Language models rank what they see at the start and end of a long prompt better than what is in the middle. Reelsaw chunks the transcript at long pauses with 20% overlap, collects every standalone moment per chunk in parallel, then pools and ranks them. Weak picks are dropped relative to the run, not by a fixed count, so a two-hour episode yields as many clips as it earns.",
        ],
      },
      {
        heading: "Two people in frame",
        bullets: [
          "Split: two speakers stacked top and bottom, when the shot has two faces and detection is confident.",
          "Face: the crop follows whoever is talking, chosen by mouth motion correlated with the audio envelope, with a minimum of 2.5 seconds per shot so it never flickers.",
          "Stack: slides or a screen on top, a zoomed webcam below, for video podcasts that share a screen.",
          "Fit: the whole frame over a blurred background when there is no face, such as a title card or b-roll.",
          "Clips are split at scene cuts and face-presence changes, so one clip can open on a wide shot and switch to a talking head. Override any section in the editor.",
        ],
      },
      {
        heading: "Fillers, repetitions and false starts",
        paragraphs: [
          "Disfluencies are cut with jump cuts. Each cut is located by forced alignment and checked by listening to the seam, so karaoke highlights still land on the syllable. Every fix shows inline in the transcript with accept and reject, long pauses can be shortened, and your decisions survive re-runs. A wrong automatic edit is worse than a missed one, so anything uncertain goes to review instead of being applied.",
        ],
      },
      {
        heading: "Names and jargon",
        paragraphs: ["Guest names, product names and recurring terms go into a vocabulary. Transcription is biased toward them and a constrained correction pass fixes the rest, so captions do not misspell the person you just introduced."],
      },
      {
        heading: "What a two-hour episode costs",
        table: {
          columns: ["", "Reelsaw", "Hosted, metered tools"],
          rows: [
            ["Software", "$0", "Plan with a monthly minute or credit budget"],
            ["120 minutes of source", "Local: electricity. Cloud transcription: that vendor's per-minute price, no markup", "120 credits or minutes from the budget; several episodes a month usually means the next tier"],
            ["Where the episode goes", "Your machine", "The vendor's servers"],
            ["Back catalogue of 100 episodes", "Queue them; pg-boss runs them through and resumes after restarts", "Buy credits or spread it over months"],
          ],
        },
      },
    ],
    faqs: [
      { q: "Does Reelsaw handle video podcasts with two cameras?", a: "Yes. With two people in a wide shot it follows whoever is talking; when detection is not confident it stacks both speakers in a split layout. Each clip is split into sections at scene cuts, and you can force any section to face, split, stack, fit or centre." },
      { q: "Does it work on audio-only podcasts?", a: "It needs a video input. For audio-only shows, render a static or waveform video first; the fit layout places it over a blurred background with captions and a hook." },
      { q: "Can my producer and I both use the same install?", a: "Yes. The first account is the admin, sign-up can be open, approval-based or closed, and each person gets their own project defaults, vocabulary, API keys and usage. Admins can set per-user quotas." },
    ],
    sources: [
      { href: "https://github.com/osbytes/reelsaw#readme", label: "Reelsaw README: selection, disfluency cuts, layouts" },
      { href: "https://github.com/osbytes/reelsaw/blob/main/docs/LAYOUTS.md", label: "Reelsaw layouts reference" },
    ],
  },
];

export const guideBySlug = (slug: string) => GUIDES.find((g) => g.slug === slug);
