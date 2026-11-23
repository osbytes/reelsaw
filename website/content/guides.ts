import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { CHECKED } from "./reelsaw";
import type { Guide } from "./types";

export const GUIDES: Guide[] = [
  {
    slug: "free-ai-clip-generator-no-watermark",
    metaTitle: t(msg`Free AI clip generator with no watermark (self-hosted)`),
    metaDescription: t(
      msg`Most free AI clippers watermark clips until you pay. Self-hosted Reelsaw is open source, so clips are free and never watermarked. How the tools compare.`,
    ),
    h1: t(msg`A free AI clip generator with no watermark, and why that is rare`),
    intro: [
      t(
        msg`Every hosted clipping service pays for GPUs, storage and bandwidth on your behalf, so its free tier has to push you toward a plan. The watermark is how: it makes the free clips unusable in public while still showing you the product works.`,
      ),
      t(
        msg`The structural exception is software you run yourself. Reelsaw is an open-source AI clipper that installs with one command; on your own machine it has no plans and never writes a watermark, because there is nothing to upsell. (Its hosted service at app.reelsaw.com is a normal hosted product: the Free plan watermarks, paid plans from $12 a month do not.)`,
      ),
    ],
    sections: [
      {
        heading: t(msg`Why every free clip generator adds a watermark`),
        paragraphs: [
          t(
            msg`A clipping run costs the vendor real money: transcription minutes, a language-model call to pick moments, face detection and a video render. A free plan that produced clean clips would lose money on every user who never converts. So free plans do one or more of: watermark the output, cap the minutes, lower the resolution, or delete the clips after a few days.`,
          ),
        ],
      },
      {
        heading: t(msg`The structural exception: software you run yourself`),
        paragraphs: [
          t(
            msg`When the software runs on your machine, there is no vendor paying for compute, so there is no reason to watermark. Reelsaw transcribes, picks moments, reframes to 9:16 and burns in captions using your CPU and either local models (Ollama, Whisper) or cloud models you hold the keys for.`,
          ),
          t(
            msg`The install is one command on macOS, Linux or Windows. It needs Docker and about 10 GB of disk; the installer picks a language model sized to your RAM and waits until the app answers.`,
          ),
        ],
      },
      {
        heading: t(msg`How the main tools handle watermarks`),
        table: {
          columns: [t(msg`Tool`), t(msg`Free tier`), t(msg`Cheapest way to lose the watermark`)],
          rows: [
            [
              t(msg`Reelsaw`),
              t(msg`Self-hosted: none, ever. Hosted: first video up to 60 min, then 20 min/mo with watermark`),
              t(msg`Self-host ($0) or Starter, $12/mo`),
            ],
            [
              t(msg`OpenShorts`),
              t(msg`Self-hosted: none. Cloud: first video up to 60 min, then 20 min/mo with watermark`),
              t(msg`Self-host ($0) or Cloud from $12/mo`),
            ],
            [t(msg`Opus Clip`), t(msg`Captions with watermark, exports expire after 3 days`), t(msg`Starter, $15/mo`)],
            [
              t(msg`Vizard`),
              t(msg`60 upload min/mo, 720p, 3-day storage; 'No watermark' is a Creator feature`),
              t(msg`Creator, $29/mo or $14.50/mo billed yearly`),
            ],
            [t(msg`2short.ai`), t(msg`30 min of analysis/mo`), t(msg`Page says 'goodbye to watermarks' without a plan; Lite is $9.90/mo`)],
            [t(msg`quso.ai`), t(msg`75 credits/mo, 720p with a quso.ai watermark, 7-day retention`), t(msg`Lite, $29/mo`)],
            [
              t(msg`Submagic`),
              t(msg`No free plan listed on the pricing page`),
              t(msg`Starter, $19/mo or $12/mo yearly, no watermark on listed plans. Magic Clips is a $19/mo add-on`),
            ],
            [t(msg`Klap`), t(msg`No free plan listed`), t(msg`Basic, $14/mo billed yearly; watermark not stated`)],
          ],
        },
        paragraphs: [
          t(
            msg`Prices and limits read from each vendor's public pricing page on ${{ checked: CHECKED }}. Vendors change plans without notice; verify before you buy.`,
          ),
        ],
      },
      {
        heading: t(msg`What you trade for the self-hosted zero`),
        bullets: [
          t(
            msg`Hardware: Docker, about 10 GB of disk, 8 GB of RAM with a hosted provider or more for a local language model (the installer checks the machine and picks qwen2.5:14b with 24 GB of RAM or a 12 GB GPU, qwen2.5:7b from 12 GB, gemma3:4b below; it asks before it installs anything).`,
          ),
          t(
            msg`Time: a fully local run on a CPU is slower than a vendor's GPU. Cloud transcription and selection models bring that back down; you pay those vendors directly, with no markup.`,
          ),
          t(msg`Setup: one command, then an account that becomes the admin. Updates are a Docker pull.`),
          t(
            msg`No social publishing: Reelsaw exports a zip with a paste-ready caption, a YouTube Data API body and a TikTok post body per clip, and leaves posting to you or an agent.`,
          ),
        ],
      },
    ],
    faqs: [
      {
        q: t(msg`Is there a free AI clip generator without a watermark?`),
        a: t(
          msg`Yes: self-hosted software. Reelsaw is open source under the AGPL-3.0, installs with one command, and never watermarks on your own machine. OpenShorts, also open source, is watermark-free when self-hosted. Both hosted services watermark their free plans.`,
        ),
      },
      {
        q: t(msg`Do any hosted free plans skip the watermark?`),
        a: t(
          msg`Among the tools checked on ${{ checked: CHECKED }}, Submagic lists no watermark on any plan but has no free plan on the pricing page; 2short.ai makes a general 'no watermarks' claim without tying it to a plan. Opus Clip, quso.ai, OpenShorts Cloud and hosted Reelsaw watermark their free tiers; Vizard lists watermark removal as a paid Creator feature ($29/mo, or $14.50/mo billed yearly).`,
        ),
      },
      {
        q: t(msg`How do I remove a watermark from a clip I already made?`),
        a: t(
          msg`Re-render it from the source without the watermark. Cropping or blurring a watermark lowers quality and usually breaks the tool's terms; running the source through Reelsaw gives you a clean clip from the original video.`,
        ),
      },
    ],
    sources: [
      { href: "https://www.opus.pro/pricing", label: t(msg`Opus Clip pricing`) },
      { href: "https://vizard.ai/pricing", label: t(msg`Vizard pricing`) },
      { href: "https://2short.ai/pricing", label: t(msg`2short.ai pricing`) },
      { href: "https://quso.ai/pricing", label: t(msg`quso.ai pricing`) },
      { href: "https://www.submagic.co/pricing", label: t(msg`Submagic pricing`) },
      { href: "https://klap.app/pricing", label: t(msg`Klap pricing`) },
      { href: "https://github.com/mutonby/openshorts", label: t(msg`OpenShorts README`) },
    ],
  },
  {
    slug: "open-source-video-clipper",
    metaTitle: t(msg`Open-source AI video clippers: what the licence gets you`),
    metaDescription: t(
      msg`Open-source AI video clippers compared (Reelsaw, AGPL-3.0; OpenShorts, MIT): the licence, the local-only path, the agent surface and the pipeline.`,
    ),
    h1: t(msg`Open-source video clippers: what 'open source' actually gets you`),
    intro: [
      t(
        msg`'Open source' on a clipping tool can mean anything from a fully local pipeline to a thin client that still calls one vendor's API. The question that matters is whether you can run every step on your own hardware, with the models you choose. Reelsaw was built to answer yes to both; OpenShorts, the other open-source clipper with traction, can pick moments locally, but Gemini is still required for layout picking and silent videos.`,
      ),
      t(msg`This page lists what to check and how each project answers.`),
    ],
    sections: [
      {
        heading: t(msg`Four things to check before you choose`),
        bullets: [
          t(
            msg`Local-only path: can every model run on your hardware, or is one vendor still required for some step? That decides whether 'self-hosted' also means 'private' and 'free'. Reelsaw: yes, by default. OpenShorts: moment picking can be local; Gemini stays required for layout picking and silent videos.`,
          ),
          t(
            msg`Provider choice: can you point each model at the vendor you want (or at a local server) without changing code? Reelsaw: every model is a provider:model string, switchable at runtime. OpenShorts: an OpenAI-compatible server for moment picking only.`,
          ),
          t(
            msg`Licence: MIT lets anyone take the code private, including as a hosted service. AGPL-3.0 requires anyone who runs a modified version for others to publish their changes. Neither is wrong; they protect different people.`,
          ),
          t(
            msg`Agent surface: an MCP server means Claude Code, Claude Desktop, Cursor or a script can drive the whole pipeline. Check whether it is plan-gated.`,
          ),
          t(msg`Pipeline depth: how moments are chosen, whether filler cuts are verified, what the editor can override, and whether a crashed run resumes.`),
        ],
      },
      {
        heading: t(msg`Reelsaw and OpenShorts, side by side`),
        table: {
          columns: ["", t(msg`Reelsaw`), t(msg`OpenShorts`)],
          rows: [
            [
              t(msg`Fully local, no API keys`),
              t(msg`Yes, the installer's default: Ollama, local Whisper, on-device alignment and face detection`),
              t(msg`Partly: moment picking can be local; Gemini is still needed for layout picking and silent videos`),
            ],
            [
              t(msg`Language model`),
              t(
                msg`Any: OpenAI, Anthropic, Google, Groq, Vercel AI Gateway, OpenCode, OpenRouter, Ollama, vLLM, LM Studio or any OpenAI-compatible server; switched at runtime`,
              ),
              t(msg`Gemini by default; any OpenAI-compatible server for moment picking only`),
            ],
            [
              t(msg`Transcription`),
              t(msg`Any: Deepgram, AssemblyAI, OpenAI, Groq, or a local Whisper server (Speaches, CPU or CUDA)`),
              t(msg`faster-whisper, optional Parakeet backend; GPU override`),
            ],
            [
              t(msg`GPU`),
              t(msg`Compose override: faster-whisper on CUDA, Ollama in a container, NVENC encoding; detection models on the CPU`),
              t(msg`Image build flag: faster-whisper on CUDA, NVENC encoding, detection models on CUDA`),
            ],
            [t(msg`Licence`), t(msg`AGPL-3.0, whole repository`), t(msg`MIT core; cloud/ directory under a commercial licence`)],
            [
              t(msg`Stack`),
              t(msg`TypeScript: Hono, tRPC, Drizzle, Postgres, pg-boss, React`),
              t(msg`Python: FastAPI, faster-whisper, MediaPipe, YOLOv8; React frontend`),
            ],
            [
              t(msg`Moment selection`),
              t(msg`Map, pool, rank: chunked at pauses, rubric scored as a median of k samples, pairwise top-10 with swapped positions, optional judge model`),
              t(msg`Gemini picks 3 to 15 moments per video`),
            ],
            [
              t(msg`Reframing`),
              t(msg`Face, split, stack, fit per shot cut; webcam-tile stacks; hand-set crops; per-section overrides`),
              t(msg`Track, general, split, screencast modes picked per video`),
            ],
            [t(msg`Filler removal`), t(msg`Yes, forced-alignment verified, each cut reviewable`), t(msg`Not listed`)],
            [
              t(msg`Editor`),
              t(msg`Live 9:16 preview, multi-lane timeline, snapping, layout sections, layers, layer templates, fades and crossfades, intros and outros, undo`),
              t(msg`Dashboard with per-video settings`),
            ],
            [t(msg`Agents`), t(msg`MCP server (OAuth optional), operator CLI`), t(msg`MCP server, REST API with webhooks, CLI, agent skill`)],
            [
              t(msg`Beyond clipping`),
              t(msg`Export zip with platform-ready metadata`),
              t(msg`Dubbing, AI UGC videos, YouTube studio, direct publishing, hosted cloud`),
            ],
            [t(msg`Multi-user`), t(msg`Accounts, admin approval, quotas, usage, runtime model switching`), t(msg`Hosted accounts with API keys`)],
            [t(msg`Durability`), t(msg`Every stage is a Postgres job that checkpoints and resumes`), t(msg`Not documented`)],
          ],
        },
        paragraphs: [t(msg`Read from each project's README on ${{ checked: CHECKED }}. Both move quickly; check the repositories for the current state.`)],
      },
      {
        heading: t(msg`Which one to pick`),
        bullets: [
          t(
            msg`Pick Reelsaw for the core job and control over it: fully local by default with no API key, any provider for any model, selection you can audit, cuts you can review, per-segment framing, an editor, teams, and a pipeline that resumes after a crash.`,
          ),
          t(msg`Pick OpenShorts for breadth around the job: dubbing, UGC generation, publishing and a bigger community.`),
          t(
            msg`Pick either hosted plan if you do not want to run a machine: both are Free, then $12, $29 and $59 a month. Pick self-hosted Reelsaw if the source must stay on your hardware or you clip past a monthly minute cap.`,
          ),
        ],
      },
    ],
    faqs: [
      {
        q: t(msg`Is there an open-source alternative to Opus Clip?`),
        a: t(
          msg`Yes. Reelsaw (AGPL-3.0, TypeScript) and OpenShorts (MIT, Python) are both open-source AI clippers you can self-host with Docker Compose. Reelsaw runs with no API key at all and lets you pick any provider per model; OpenShorts can pick moments locally but still needs Gemini for layout picking and silent videos. See the Opus Clip comparison for a feature-by-feature table.`,
        ),
      },
      {
        q: t(msg`Does open source mean my video stays private?`),
        a: t(
          msg`Only if every model can run locally. Reelsaw's installer sets up Ollama and a local Whisper so nothing leaves your machine; with cloud models, only audio (for transcription) or transcript text (for selection) is sent to the vendor you chose.`,
        ),
      },
      {
        q: t(msg`Can I modify Reelsaw and run it for my team?`),
        a: t(
          msg`Yes. The AGPL-3.0 allows internal use and modification freely. If you offer a modified version to the public as a service, you must publish your changes.`,
        ),
      },
    ],
    sources: [
      { href: "https://github.com/osbytes/reelsaw#readme", label: t(msg`Reelsaw README`) },
      { href: "https://github.com/mutonby/openshorts", label: t(msg`OpenShorts README`) },
    ],
  },
  {
    slug: "youtube-to-shorts-converter",
    metaTitle: t(msg`YouTube to Shorts converter you run on your own machine`),
    metaDescription: t(
      msg`Paste a YouTube link, get vertical Shorts with word-highlight captions and a hook, rendered on your own hardware. Open source, no credits, no watermark.`,
    ),
    h1: t(msg`YouTube to Shorts converter you can run on your own machine`),
    intro: [
      t(
        msg`A YouTube link is the most common input to a clipping tool, and the first thing hosted services charge for is the minutes in it. Reelsaw takes the same link and does the whole job on your hardware: fetch, transcribe, pick moments, reframe to 9:16, caption, and hand back clips with upload metadata.`,
      ),
      t(msg`Use it on your own videos or ones you have the rights to clip.`),
    ],
    sections: [
      {
        heading: t(msg`What happens after you paste the link`),
        bullets: [
          t(msg`Ingest: yt-dlp fetches the video, ffprobe reads it, and the source is stored once so every later step can resume from it.`),
          t(
            msg`Transcribe: audio is split into chunks and transcribed in parallel with word timestamps, then names are fixed from your vocabulary and fillers are cut with verified jump cuts.`,
          ),
          t(
            msg`Pick: the transcript is chunked at long pauses, every standalone moment is scored on hook, value, flow and shareability, and the top picks are compared head-to-head. Optional focus: 'Find clips about pricing'.`,
          ),
          t(msg`Reframe: a face detector picks face, split, stack or fit per segment; the crop follows whoever is speaking.`),
          t(
            msg`Render: ffmpeg burns in karaoke captions and the hook, plus your intro and outro, in one encode. Clips stream into the workspace as they finish.`,
          ),
        ],
      },
      {
        heading: t(msg`What you get back`),
        bullets: [
          t(msg`Every clip as a 9:16 MP4 with its score, layout and a hook overlay.`),
          t(
            msg`A paste-ready title, description, hashtags and caption per clip. Descriptions carry a timestamped link to the exact moment in the parent video.`,
          ),
          t(
            msg`A YouTube Data API v3 videos.insert body per clip (private by default) and a TikTok Content Posting API body, so a script or agent can upload.`,
          ),
          t(msg`A manifest and a CSV for the whole batch. The same through the MCP server, so an agent can run the loop end to end.`),
        ],
      },
      {
        heading: t(msg`How it compares to hosted converters`),
        table: {
          columns: ["", t(msg`Reelsaw`), t(msg`Hosted converters (Opus Clip, Vizard, 2short, quso)`)],
          rows: [
            [
              t(msg`Price`),
              t(msg`$0 software on your hardware (or hosted: Free, then $12 to $59 a month)`),
              t(msg`Free tiers with watermarks, 720p or expiring exports; paid from about $10 to $29 a month`),
            ],
            [t(msg`Source length`), t(msg`No limit beyond your disk`), t(msg`Metered per minute or per credit; some cap export length`)],
            [t(msg`Where the video goes`), t(msg`Stays on your machine`), t(msg`Uploaded to the vendor`)],
            [t(msg`Automation`), t(msg`MCP server and CLI on every install, including hosted Free`), t(msg`API or MCP on higher plans, where offered`)],
            [t(msg`Publishing`), t(msg`Export with API bodies; no built-in posting`), t(msg`Built-in scheduling on most paid plans`)],
          ],
        },
      },
    ],
    faqs: [
      {
        q: t(msg`Can Reelsaw download any YouTube video?`),
        a: t(msg`It uses yt-dlp, which fetches public videos. Clip only content you own or have permission to use; YouTube's terms apply to downloading.`),
      },
      {
        q: t(msg`Does it upload the Shorts to YouTube for me?`),
        a: t(
          msg`Not directly. Export all includes a YouTube Data API v3 videos.insert body per clip, set to private, so a script or an agent on the MCP server can upload with your credentials.`,
        ),
      },
      {
        q: t(msg`How long does a one-hour video take?`),
        a: t(
          msg`It depends on the models. Cloud transcription of an hour takes a few minutes; fully local on a CPU with faster-whisper-small runs roughly in real time. Rendering is a few seconds per clip. Every stage checkpoints, so a restart resumes rather than starts over.`,
        ),
      },
    ],
    sources: [{ href: "https://github.com/osbytes/reelsaw#readme", label: t(msg`Reelsaw README: pipeline, export formats and MCP tools`) }],
  },
  {
    slug: "podcast-to-shorts",
    metaTitle: t(msg`Podcast to shorts: speaker reframing, filler cuts, no meter`),
    metaDescription: t(
      msg`Turn long podcast episodes into vertical clips that follow the active speaker, with filler cuts you can review and no per-minute price. Open source.`,
    ),
    h1: t(msg`Podcast to shorts without paying by the minute`),
    intro: [
      t(
        msg`Podcasts are the worst case for per-minute pricing: long episodes, two or three faces, and a lot of 'um' between the good parts. Reelsaw was built around that shape: it chunks long transcripts without losing the middle, stacks speakers when it cannot pick one, and cuts fillers with cuts it has checked.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`Long episodes without losing the middle`),
        paragraphs: [
          t(
            msg`Language models rank what they see at the start and end of a long prompt better than what is in the middle. Reelsaw chunks the transcript at long pauses with 20% overlap, collects every standalone moment per chunk in parallel, then pools and ranks them. Weak picks are dropped relative to the run, not by a fixed count, so a two-hour episode yields as many clips as it earns.`,
          ),
        ],
      },
      {
        heading: t(msg`Two people in frame`),
        bullets: [
          t(msg`Split: two speakers stacked top and bottom, when the shot has two faces and detection is confident.`),
          t(
            msg`Face: the crop follows whoever is talking, chosen by an audio-visual model that checks each mouth against the speech (a listener who laughs or drinks is not the talker), with a minimum of 2.5 seconds per shot so it never flickers.`,
          ),
          t(
            msg`Stack: slides or a screen on top, the webcam tile below (the picture-in-picture box of a Zoom, Teams, Meet or OBS recording), for video podcasts that share a screen.`,
          ),
          t(
            msg`No face, one moving subject: b-roll of a ship, a car or a product in the hand gets a 9:16 crop that follows what moves, held still when it stays put.`,
          ),
          t(
            msg`Fit: the whole frame over a blurred background when there is no face and nothing clearly stands out, such as a title card, a slide or a wide landscape.`,
          ),
          t(
            msg`Phone footage edited into the frame between blurred or black bars is cropped to the picture itself, so a vertical clip fills the vertical frame.`,
          ),
          t(
            msg`Clips are split at scene cuts and face-presence changes, so one clip can open on a wide shot and switch to a talking head. Override any section in the editor.`,
          ),
        ],
      },
      {
        heading: t(msg`Fillers, repetitions and false starts`),
        paragraphs: [
          t(
            msg`Disfluencies are cut with jump cuts. Each cut is located by forced alignment and checked by listening to the seam, so karaoke highlights still land on the syllable. Every fix shows inline in the transcript with accept and reject, long pauses can be shortened, and your decisions survive re-runs. A wrong automatic edit is worse than a missed one, so anything uncertain goes to review instead of being applied.`,
          ),
        ],
      },
      {
        heading: t(msg`Names and jargon`),
        paragraphs: [
          t(
            msg`Guest names, product names and recurring terms go into a vocabulary. Transcription is biased toward them and a constrained correction pass fixes the rest, so captions do not misspell the person you just introduced.`,
          ),
        ],
      },
      {
        heading: t(msg`What a two-hour episode costs`),
        table: {
          columns: ["", t(msg`Reelsaw`), t(msg`Hosted, metered tools`)],
          rows: [
            [t(msg`Software`), "$0", t(msg`Plan with a monthly minute or credit budget`)],
            [
              t(msg`120 minutes of source`),
              t(msg`Local: electricity. Cloud transcription: that vendor's per-minute price, no markup`),
              t(msg`120 credits or minutes from the budget; several episodes a month usually means the next tier`),
            ],
            [t(msg`Where the episode goes`), t(msg`Your machine`), t(msg`The vendor's servers`)],
            [
              t(msg`Back catalogue of 100 episodes`),
              t(msg`Queue them; pg-boss runs them through and resumes after restarts`),
              t(msg`Buy credits or spread it over months`),
            ],
          ],
        },
      },
    ],
    faqs: [
      {
        q: t(msg`Does Reelsaw handle video podcasts with two cameras?`),
        a: t(
          msg`Yes. With two people in a wide shot it follows whoever is talking; when detection is not confident it stacks both speakers in a split layout. Each clip is split into sections at scene cuts, and you can force any section to face, split, stack, fit or centre.`,
        ),
      },
      {
        q: t(msg`Does it work on audio-only podcasts?`),
        a: t(
          msg`It needs a video input. For audio-only shows, render a static or waveform video first; the fit layout places it over a blurred background with captions and a hook.`,
        ),
      },
      {
        q: t(msg`Can my producer and I both use the same install?`),
        a: t(
          msg`Yes. The first account is the admin, sign-up can be open, approval-based or closed, sign-up rules can hold or block particular addresses, emails and domains while everyone else gets straight in, and each person gets their own project defaults, vocabulary, API keys and usage. Admins can set per-user quotas.`,
        ),
      },
    ],
    sources: [
      { href: "https://github.com/osbytes/reelsaw#readme", label: t(msg`Reelsaw README: selection, disfluency cuts, layouts`) },
      { href: "https://github.com/osbytes/reelsaw/blob/main/docs/LAYOUTS.md", label: t(msg`Reelsaw layouts reference`) },
    ],
  },
  {
    slug: "automate-youtube-shorts-n8n",
    metaTitle: t(msg`Automate YouTube Shorts with n8n: clip and post every new upload`),
    metaDescription: t(
      msg`Free n8n workflows that turn every new YouTube upload into vertical clips with captions and queue them in Buffer. Signed webhooks, no polling, self-hosted or hosted Reelsaw.`,
    ),
    h1: t(msg`Automate YouTube Shorts with n8n: clip and post every new upload`),
    intro: [
      t(
        msg`Most Shorts automations stop at the hard part. Downloading a video and uploading a file is easy in n8n; picking the 30 seconds worth posting, reframing a landscape shot to 9:16 and timing captions to the words is not. Hosted clippers do that step, but their APIs usually sit on higher plans and charge by the minute.`,
      ),
      t(
        msg`Reelsaw does that step inside a pipeline. Two ready-made n8n workflows watch your channel, send each new upload to Reelsaw, and when Reelsaw signals that the clips are rendered, queue each one in Buffer with its caption and hashtags. Nothing waits in between. It runs against a Reelsaw you host yourself or the hosted service, including the Free plan.`,
      ),
    ],
    sections: [
      {
        heading: t(msg`What the workflows do`),
        bullets: [
          t(
            msg`Start (1/2): an RSS Feed Trigger on your channel's YouTube feed fires for each new upload and creates a Reelsaw project from the link, with an optional clip cap and a focus such as 'Find clips about pricing'. It tags the project with metadata (the video id and the workflow's name) and ends.`,
          ),
          t(
            msg`Signal: when the clips are rendered, Reelsaw sends a signed project.done webhook to the second workflow with every clip's title, caption, hashtags, score and a share link that downloads without a credential. Deliveries are retried for about a day if n8n is down.`,
          ),
          t(msg`Verify (2/2): a Code node checks the Standard Webhooks signature and refuses forged or replayed deliveries, then answers Reelsaw at once.`),
          t(
            msg`Route: only projects tagged by the start workflow are posted, so a project you start by hand is not. The best clips by score go on, and each clip is posted once even if the project is re-run.`,
          ),
          t(
            msg`Publish: each clip goes to Buffer's queue (or in as a draft to review) on the channels you list, YouTube included. Disabled alternatives upload straight to YouTube Shorts with n8n's YouTube node or POST each clip to your own endpoint.`,
          ),
        ],
      },
      {
        heading: t(msg`Why it needs no MCP client, community node or wait loop`),
        paragraphs: [
          t(
            msg`Reelsaw's automation surface is an MCP server at /api/mcp, the same tools Claude and Cursor use. The endpoint is stateless and answers plain JSON, so calling a tool is one HTTP POST with an Authorization header and a tools/call body. Finished projects arrive as webhooks, so the workflows use n8n's built-in Webhook, HTTP Request and Code nodes only and run on n8n Cloud and self-hosted n8n alike.`,
          ),
          t(
            msg`An n8n behind NAT or on a laptop cannot receive webhooks. For that case a third, single workflow creates the project and asks Reelsaw for its state until the clips are ready, up to two minutes per call.`,
          ),
        ],
      },
      {
        heading: t(msg`Set it up`),
        bullets: [
          t(
            msg`Create an API key in Reelsaw under Settings, API keys and MCP, and add it to n8n as a Header Auth credential (Authorization, Bearer followed by the key).`,
          ),
          t(msg`Import reelsaw-shorts-start.json and reelsaw-shorts-publish.json into n8n (Workflows, Import from file).`),
          t(msg`In the start workflow, set your Reelsaw address (or keep app.reelsaw.com), the most clips per video and your channel id in the RSS trigger.`),
          t(
            msg`Copy the publish workflow's webhook URL and add it in Reelsaw under Settings, Webhooks (or run the workflow's create_webhook branch). Paste the signing secret Reelsaw shows once into the Verify signature node.`,
          ),
          t(
            msg`Add a Buffer API key as a second Header Auth credential, list your Buffer channel ids, activate the workflow and press Send test in Reelsaw: the delivery log should show 200.`,
          ),
        ],
      },
      {
        heading: t(msg`How it compares to clipping APIs`),
        table: {
          columns: ["", t(msg`Reelsaw + n8n`), t(msg`Hosted clipping APIs`)],
          rows: [
            [t(msg`Price`), t(msg`$0 self-hosted; hosted Free, then $12 to $59 a month`), t(msg`API access on higher plans, metered per minute or credit`)],
            [t(msg`Where the video goes`), t(msg`Your machine (self-hosted) or Reelsaw's hosted service`), t(msg`The vendor's servers`)],
            [
              t(msg`n8n setup`),
              t(msg`Import two files; stock Webhook, HTTP Request and Code nodes`),
              t(msg`HTTP nodes against each vendor's REST API, or a community node`),
            ],
            [t(msg`Clips-ready trigger`), t(msg`Signed webhooks on every plan, Free included`), t(msg`Polling, or webhooks on some plans`)],
            [t(msg`Models`), t(msg`Any provider, or fully local with Ollama and Whisper`), t(msg`The vendor's choice`)],
            [
              t(msg`Publishing`),
              t(msg`Buffer queue by default; YouTube upload or your own endpoint as alternatives`),
              t(msg`Built-in scheduling on some plans`),
            ],
          ],
        },
      },
    ],
    faqs: [
      {
        q: t(msg`Does it post the clips for me?`),
        a: t(
          msg`Yes, through Buffer by default: each clip is added to your Buffer queue (or saved as a draft to review) with its caption and hashtags, on the channels you list. Buffer fetches the video from the clip's share link when the post goes out; links last 90 days by default and can be revoked. A disabled branch uploads to YouTube Shorts directly with n8n's YouTube node (private until you change it), and another POSTs each clip to your own endpoint.`,
        ),
      },
      {
        q: t(msg`Why Buffer and not Metricool?`),
        a: t(
          msg`Buffer's API takes a video URL in one createPost call with a personal API key and no app review. Metricool also takes a URL but needs a second call to copy the file first; the setup guide on GitHub says which two nodes to swap in for it.`,
        ),
      },
      {
        q: t(msg`My n8n is not reachable from the internet. Can I still use it?`),
        a: t(
          msg`Yes, with the polling workflow (reelsaw-youtube-to-shorts.json): it creates the project and asks Reelsaw for its state in a loop until the clips are rendered. If Reelsaw and n8n are self-hosted on the same network, the admin can allow private webhook URLs instead.`,
        ),
      },
      {
        q: t(msg`Will it clip my Shorts and live streams too?`),
        a: t(
          msg`The channel feed lists every upload, including Shorts and streams. Reelsaw clips a stream once it has ended and its recording is up; a link to a stream that is still live, has not started, or has just ended and is still being processed by YouTube, is refused with a message saying so. Add an IF node on the title or link before the Settings node to skip what you do not want clipped.`,
        ),
      },
      {
        q: t(msg`Can I use it with Make, Zapier or a script instead of n8n?`),
        a: t(
          msg`Yes. The workflows are plain HTTP: POST a JSON-RPC tools/call to /api/mcp with your API key as a Bearer token. The same calls work from any tool that can send an HTTP request, and agents can use the MCP server directly. For instant triggers, Zapier and Make can subscribe a catch hook with the create_webhook tool (delete_webhook unsubscribes); deliveries are signed with the Standard Webhooks scheme. The repository has a Make version of this pipeline (docs/make) built from Make's MCP Client and Custom webhook modules, and a Zapier app.`,
        ),
      },
    ],
    sources: [
      {
        href: "https://github.com/osbytes/reelsaw/blob/main/docs/n8n/README.md",
        label: t(msg`Reelsaw n8n workflows: setup, routing and troubleshooting`),
      },
      { href: "https://github.com/osbytes/reelsaw#mcp-drive-reelsaw-from-an-agent", label: t(msg`Reelsaw README: MCP server and tools`) },
      { href: "https://developers.buffer.com/examples/create-video-post.html", label: t(msg`Buffer API: create a video post`) },
      { href: "https://www.standardwebhooks.com", label: t(msg`Standard Webhooks specification`) },
      { href: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/", label: t(msg`n8n docs: Webhook node`) },
    ],
  },
];
