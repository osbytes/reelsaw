import Image from "next/image";
import {
  ArrowRight,
  Bot,
  Captions,
  Cpu,
  Database,
  Download,
  Film,
  Layers,
  ListChecks,
  Lock,
  Plug,
  Scissors,
  ScanFace,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react";
import editor from "@/public/editor.png";
import transcriptFixes from "@/public/transcript-fixes.png";
import workspace from "@/public/workspace.png";
import { Code, Command } from "@/components/command";
import { PipelineFilm } from "@/components/pipeline-film";
import { JsonLd } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { GitHubMark } from "@/components/logo";
import { ALTERNATIVE_LINKS, GUIDE_NAV } from "@/content/links";
import { CHECKED } from "@/content/reelsaw";
import { SITE } from "@/lib/site";

const STEPS = [
  {
    icon: Download,
    title: "Ingest",
    body: "Paste a YouTube link or upload a file. yt-dlp fetches it, ffprobe reads it, and the source is stored once so every later step can resume from it.",
  },
  {
    icon: Captions,
    title: "Transcribe and clean",
    body: "Audio is transcribed in parallel chunks with word timestamps. Names are fixed from your vocabulary, fillers and false starts are cut with jump cuts, and every cut is checked by listening to the seam.",
  },
  {
    icon: Sparkles,
    title: "Pick the moments",
    body: "Map, pool, rank: the transcript is chunked at long pauses, every standalone moment is collected, scored on hook, value, flow and shareability, and the top picks are compared head-to-head with positions swapped to cancel judge bias.",
  },
  {
    icon: ScanFace,
    title: "Reframe and render",
    body: "A 1.2 MB face detector on the CPU picks a layout per shot cut: follow the speaker, stack two people, slides over the webcam tile, or fit the whole frame. ffmpeg burns in captions, hook, intro and outro in one encode.",
  },
];

const FEATURES = [
  {
    icon: Plug,
    title: "Fully local by default. Any vendor by choice.",
    body: "The installer sets up Ollama and a local Whisper, so nothing leaves the machine and no key is needed. Language, transcription and alignment models are each a provider:model string you can point at OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, Vercel AI Gateway, or any OpenAI-compatible server. No vendor is baked in; admins switch at runtime.",
  },
  {
    icon: ListChecks,
    title: "Research-backed clip selection",
    body: "No fixed clip count. Weak picks are dropped relative to the run, the best clip is always kept, and a different judge model can score and compare so a model never grades its own hooks. Click a score for the rubric breakdown.",
  },
  {
    icon: Scissors,
    title: "Clean transcripts, kept honest",
    body: "Disfluencies are located by forced alignment so karaoke highlights land on the syllable. Each fix shows inline with accept and reject, long pauses can be shortened, and your decisions survive re-runs.",
  },
  {
    icon: ScanFace,
    title: "Smart 9:16 reframing",
    body: "Face, split, stack and fit layouts chosen per shot cut. Webcam-tile stacks, crowds shown whole, hand-set crops, and one clip's framing copied to the project. Override per project, per clip or per section.",
  },
  {
    icon: Captions,
    title: "Captions that read",
    body: "AI-picked key words coloured and enlarged, readability limits on line length and time on screen, karaoke word highlight, boxed or outlined. Drag caption and hook positions on a live preview with platform safe zones.",
  },
  {
    icon: Film,
    title: "A real editor",
    body: "Live preview with the clip's framing and captions, a multi-lane timeline with zoom and snapping, frame-accurate trims, layout sections, layers, transitions, undo and redo. Keyboard first, shortcuts listed under ?.",
  },
  {
    icon: Layers,
    title: "Library, templates and export",
    body: "A library of intros, outros, logos, stickers, b-roll and music. Layer templates save a look once and apply it to any clip. Export all as a zip with paste-ready text, YouTube Data API and TikTok post bodies, a manifest and a CSV per clip.",
  },
  {
    icon: Users,
    title: "Accounts, approval and quotas",
    body: "The first account is the admin. Open, approval or closed sign-up, per-user quotas, retention, captcha, email notices and usage per account. Admins switch models and providers at runtime without a restart.",
  },
  {
    icon: Database,
    title: "Reliable, resumable, scalable",
    body: 'Every stage is a pg-boss job in Postgres that checkpoints its output. A crashed worker resumes where it left off, a long video on a slow local model keeps the parts it finished (the project shows "13 of 43 parts, about 1 h left"), orphaned work is re-queued, and extra worker containers scale rendering. Local disk or any S3-compatible storage.',
  },
];

const MCP_TOOLS = [
  "create_project",
  "wait_for_project",
  "get_transcript",
  "search_clips",
  "get_clip",
  "update_clip",
  "create_clip",
  "search_assets",
  "apply_layer_template",
  "export_project",
];

function SectionHeading({ eyebrow, title, body, id }: { eyebrow: string; title: string; body?: string; id?: string }) {
  return (
    <div className="mx-auto flex max-w-[64ch] flex-col items-center gap-3 text-center">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="text-[30px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[38px]">
        {title}
      </h2>
      {body && <p className="text-[16px] leading-relaxed text-ink2 text-pretty">{body}</p>}
    </div>
  );
}

function HomeJsonLd() {
  // The application sits under the source code (targetProduct), not at the top level. Google treats a
  // top-level SoftwareApplication as a rich result candidate, and that requires aggregateRating or
  // review, which an open-source project has no honest source for.
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareSourceCode",
        name: SITE.name,
        url: SITE.url,
        codeRepository: SITE.github,
        programmingLanguage: "TypeScript",
        runtimePlatform: "Node.js",
        license: "https://www.gnu.org/licenses/agpl-3.0.html",
        sameAs: [SITE.github, SITE.glama],
        targetProduct: {
          "@type": "SoftwareApplication",
          name: SITE.name,
          url: SITE.url,
          description: SITE.description,
          applicationCategory: "MultimediaApplication",
          applicationSubCategory: "Video editing",
          operatingSystem: "Docker (Linux, macOS, Windows)",
          softwareHelp: { "@type": "CreativeWork", name: "Reelsaw README", url: `${SITE.github}#readme` },
          downloadUrl: SITE.releases,
          installUrl: `${SITE.url}/#install`,
          isAccessibleForFree: true,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          screenshot: `${SITE.url}/workspace.png`,
          featureList: FEATURES.map((f) => f.title),
        },
      },
      {
        "@type": "WebSite",
        name: SITE.name,
        url: SITE.url,
      },
    ],
  };
  return <JsonLd data={data} />;
}

export default function HomePage() {
  return (
    <>
      <HomeJsonLd />
      <Header />
      <main id="main">
        {/* Hero */}
        <section className="relative overflow-hidden" aria-labelledby="hero-title">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--acc-soft),transparent_70%)] opacity-70"
            aria-hidden
          />
          <div className="container-page flex flex-col items-center gap-8 pt-16 pb-12 text-center sm:pt-24">
            <p className="chip border border-line bg-panel text-ink2">
              <Lock className="h-3.5 w-3.5 text-acc-text" aria-hidden />
              Open source · Fully local, no API keys · Or any AI provider
            </p>
            <h1 id="hero-title" className="text-[40px] leading-[1.02] font-extrabold tracking-[-0.02em] sm:text-[60px]">
              Long videos in.
              <br />
              Vertical clips out.
              <br />
              On your hardware, or hosted.
            </h1>
            <p className="max-w-[60ch] text-[17px] leading-relaxed text-ink2 text-pretty sm:text-[19px]">
              Reelsaw transcribes a video, asks a language model for the most clippable moments, then renders 9:16 clips with word-highlight captions and a hook
              overlay. Every model runs on your machine by default, with no API key. Or point each one at any vendor you like.
            </p>
            <div className="flex w-full max-w-[720px] flex-col gap-3">
              <Command text={SITE.installSh} caption="macOS / Linux / WSL2 · needs Docker" />
              <p className="text-xs text-ink3">
                Installs the fully local stack: Ollama for the language model and Speaches for speech-to-text.{" "}
                <a href="#install" className="prose-link">
                  Windows, hosted providers and from source
                </a>
                .
              </p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <div className="flex flex-wrap items-center justify-center gap-3">
                <a href={SITE.github} target="_blank" rel="noreferrer" className="btn-primary h-10 px-4 text-sm">
                  <GitHubMark /> Star on GitHub
                </a>
                <a href={SITE.changelog} className="btn-ghost h-10 px-4 text-sm">
                  Latest release <ArrowRight className="h-4 w-4" aria-hidden />
                </a>
              </div>
              <p className="text-sm text-ink3">
                Prefer not to run a machine?{" "}
                <a href={SITE.app} className="prose-link">
                  Try the hosted Free plan
                </a>
              </p>
            </div>
          </div>
          <div className="container-page pb-20">
            <figure className="card overflow-hidden shadow-pop">
              <Image
                src={workspace}
                alt="Reelsaw project workspace: source player and clickable transcript on the left, rendered vertical clips with scores and layout badges on the right"
                priority
                sizes="(max-width: 1120px) 100vw, 1120px"
                className="h-auto w-full"
              />
              <figcaption className="border-t border-line px-4 py-2.5 text-center text-xs text-ink3">
                The project workspace: clips stream in on the right as they render, with score, layout and a copy-ready caption.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-20 border-t border-line bg-panel/40 py-20" aria-labelledby="how-title">
          <div className="container-page flex flex-col gap-12">
            <SectionHeading
              id="how-title"
              eyebrow="How it works"
              title="Four stages, each one a resumable job"
              body="Every stage checkpoints its output in Postgres. Restart the box mid-render and it picks up where it stopped."
            />
            <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="card flex flex-col gap-3 p-5">
                  <div className="flex items-center justify-between">
                    <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-acc-soft text-acc-text">
                      <s.icon className="h-[18px] w-[18px]" aria-hidden />
                    </span>
                    <span className="font-mono text-xs text-ink3">0{i + 1}</span>
                  </div>
                  <h3 className="text-[17px] font-bold tracking-tight">{s.title}</h3>
                  <p className="text-sm leading-relaxed text-ink2">{s.body}</p>
                </li>
              ))}
            </ol>
            <figure className="card overflow-hidden shadow-pop">
              <PipelineFilm />
              <figcaption className="border-t border-line px-4 py-2.5 text-center text-xs text-ink3">
                One video through the five queues:{" "}
                <span className="font-mono text-[11px]">project.ingest → project.transcribe → refine.* ×3 → project.analyze → clip.render ×N</span>. Every box
                is a pg-boss queue in Postgres; a worker restarts mid-render and resumes from its last save.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* Demo + screenshots */}
        <section className="py-20" aria-labelledby="look-title">
          <div className="container-page flex flex-col gap-12">
            <SectionHeading
              id="look-title"
              eyebrow="See it"
              title="Reframing, captions and fixes you can inspect"
              body="Nothing is a black box. Every automatic decision is shown where you are looking, with a one-click override."
            />
            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
              <figure className="card mx-auto w-full max-w-[340px] overflow-hidden">
                <video
                  src="/demo-framing.mp4"
                  poster="/demo-framing-poster.jpg"
                  controls
                  playsInline
                  preload="none"
                  className="aspect-[9/16] w-full bg-film object-cover"
                  aria-label="Demo: automatic reframing within one clip, switching between split, face, stack and fit layouts"
                >
                  <a href="/demo-framing.mp4">Download the demo video</a>
                </video>
                <figcaption className="px-3 py-2.5 text-center text-xs text-ink3">Auto reframing in one clip: split → face → stack → fit</figcaption>
              </figure>
              <div className="flex min-w-0 flex-col gap-6">
                <figure className="card overflow-hidden">
                  <Image
                    src={editor}
                    alt="Clip editor with a live 9:16 preview, captions panel and multi-lane timeline"
                    sizes="(max-width: 1024px) 100vw, 760px"
                    className="h-auto w-full"
                  />
                  <figcaption className="border-t border-line px-3 py-2.5 text-xs text-ink3">
                    The clip editor: 9:16 preview, captions panel and a multi-lane timeline with layout sections.
                  </figcaption>
                </figure>
                <figure className="card overflow-hidden">
                  <Image
                    src={transcriptFixes}
                    alt="Transcript with filler-word cuts highlighted inline and a list of fixes to accept or reject"
                    sizes="(max-width: 1024px) 100vw, 760px"
                    className="h-auto w-full"
                  />
                  <figcaption className="border-t border-line px-3 py-2.5 text-xs text-ink3">
                    Transcript fixes: filler cuts and name corrections shown inline, each with accept and reject.
                  </figcaption>
                </figure>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-20 border-t border-line bg-panel/40 py-20" aria-labelledby="features-title">
          <div className="container-page flex flex-col gap-12">
            <SectionHeading
              id="features-title"
              eyebrow="Features"
              title="Everything between the link and the upload"
              body="Built for people who publish every week and want their own pipeline, not a credit meter."
            />
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <li key={f.title} className="card flex flex-col gap-3 p-5">
                  <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-acc-soft text-acc-text">
                    <f.icon className="h-[18px] w-[18px]" aria-hidden />
                  </span>
                  <h3 className="text-[16px] font-bold tracking-tight">{f.title}</h3>
                  <p className="text-sm leading-relaxed text-ink2">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Agents */}
        <section id="agents" className="scroll-mt-20 py-20" aria-labelledby="agents-title">
          <div className="container-page grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-5">
              <p className="eyebrow">Agents and automation</p>
              <h2 id="agents-title" className="text-[30px] leading-[1.1] font-bold tracking-tight text-balance sm:text-[38px]">
                MCP is the UI for agents
              </h2>
              <p className="text-[16px] leading-relaxed text-ink2 text-pretty">
                Every editing action in the app (projects, clips, transcript fixes, library, layer templates, settings and project defaults, billing links)
                exists as a tool on the built-in MCP server; only the admin pages for users, providers and models are app-only (Model Context Protocol,
                Streamable HTTP). Claude Code, Claude Desktop, Cursor or a script can create projects, wait for them, read timed transcripts, edit layers and
                framing, create and re-render clips, manage the library and layer templates, and export the results. The same tools are on every hosted plan,
                including Free. The operator CLI mirrors the same service code for people running the box.
              </p>
              <ul className="flex flex-wrap gap-2" aria-label="Some MCP tools">
                {MCP_TOOLS.map((t) => (
                  <li key={t} className="chip border border-line bg-panel font-mono text-[11px] font-medium text-ink2">
                    {t}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3">
                <a href={SITE.mcpDocs} target="_blank" rel="noreferrer" className="btn-ghost">
                  <Bot className="h-4 w-4" aria-hidden /> MCP docs
                </a>
                <a href={SITE.cliDocs} target="_blank" rel="noreferrer" className="btn-ghost">
                  <Wrench className="h-4 w-4" aria-hidden /> Operator CLI
                </a>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <Command text={`claude mcp add --transport http reelsaw https://your-host/api/mcp --header "Authorization: Bearer rs_…"`} caption="Claude Code" />
              <Code lang="json">{`{
  "mcpServers": {
    "reelsaw": {
      "type": "http",
      "url": "https://your-host/api/mcp",
      "headers": { "Authorization": "Bearer rs_…" }
    }
  }
}`}</Code>
              <p className="text-xs text-ink3">
                Create an API key under Settings → API keys and MCP, or set MCP_OAUTH=true so claude.ai and Claude Desktop sign in through the browser.
              </p>
            </div>
          </div>
        </section>

        {/* Compare */}
        <section id="compare" className="scroll-mt-20 border-t border-line py-20" aria-labelledby="compare-title">
          <div className="container-page flex flex-col gap-10">
            <SectionHeading
              id="compare-title"
              eyebrow="How it compares"
              title="Hosted clippers charge by the minute. Self-hosted Reelsaw charges nothing."
              body={`Opus Clip, Klap, Vizard, Submagic, 2short.ai and quso.ai meter clips, minutes or credits and watermark or expire their free tiers. The other open-source clipper still needs Gemini for layout picking and silent videos. Reelsaw is AGPL-3.0 software on your own machine, fully local or with any provider you choose: no plan, no cap, no watermark. If you would rather not run a machine, hosted Reelsaw is $12 a month for 100 source minutes — the same list prices as OpenShorts Cloud, and cheaper than Opus Clip Starter at $15. Each comparison says what the other tool does better. Pricing checked ${CHECKED}.`}
            />
            <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
              <nav aria-label="Comparisons" className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold tracking-[0.08em] text-ink3 uppercase">Alternatives</h3>
                {ALTERNATIVE_LINKS.map((l) => (
                  <a key={l.href} href={l.href} className="prose-link w-fit text-[15px]">
                    {l.label}
                  </a>
                ))}
              </nav>
              <nav aria-label="Guides" className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold tracking-[0.08em] text-ink3 uppercase">Guides</h3>
                {GUIDE_NAV.map((l) => (
                  <a key={l.href} href={l.href} className="prose-link w-fit text-[15px]">
                    {l.label}
                  </a>
                ))}
              </nav>
            </div>
          </div>
        </section>

        {/* Install */}
        <section id="install" className="scroll-mt-20 border-t border-line bg-panel/40 py-20" aria-labelledby="install-title">
          <div className="container-page flex flex-col gap-12">
            <SectionHeading
              id="install-title"
              eyebrow="Install"
              title="One command, no source needed"
              body="Needs Docker with Compose and about 10 GB of disk. The script writes ~/reelsaw with a compose file and generated secrets, pulls the published image and a language model sized to your RAM, then waits until the app answers."
            />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[15px] font-bold">
                  <Cpu className="h-4 w-4 text-acc-text" aria-hidden /> macOS, Linux, WSL2
                </h3>
                <Command text={SITE.installSh} caption="bash" />
                <p className="text-xs leading-relaxed text-ink3">
                  On macOS install{" "}
                  <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="prose-link">
                    Ollama
                  </a>{" "}
                  first. On Linux the script uses a host Ollama if present, otherwise runs it in a container.
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-3">
                <h3 className="flex items-center gap-2 text-[15px] font-bold">
                  <Cpu className="h-4 w-4 text-acc-text" aria-hidden /> Windows (PowerShell)
                </h3>
                <Command text={SITE.installPs1} caption="powershell" />
                <p className="text-xs leading-relaxed text-ink3">
                  With Docker Desktop running. If script execution is blocked, download install.ps1 and run it with -ExecutionPolicy Bypass.
                </p>
              </div>
            </div>
            <div className="card grid grid-cols-1 gap-6 p-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="flex flex-col gap-2">
                <h3 className="text-[15px] font-bold">From source, or with hosted providers</h3>
                <p className="text-sm leading-relaxed text-ink2">
                  Clone the repository, copy the example environment, set an auth secret and at least one AI provider key, and bring the stack up. Open
                  http://localhost:3000; the first account becomes the admin.
                </p>
                <a href={SITE.deployDocs} target="_blank" rel="noreferrer" className="prose-link w-fit text-sm">
                  Deployment guide: providers, S3, workers, reverse proxies
                </a>
              </div>
              <Code>{`git clone https://github.com/osbytes/reelsaw.git && cd reelsaw
cp .env.example .env
# set BETTER_AUTH_SECRET, APP_URL and at least one AI provider key
docker compose up -d --build`}</Code>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
