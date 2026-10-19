// The pipeline diagram on the home page. Desktop: one SVG drawn with theme tokens, edges carry an
// animated dash so the flow reads left to right (static under prefers-reduced-motion). Phones get a
// vertical list with the same words, since the SVG would scale below legible size.

type Node = { queue: string; title: string; lines: string[] };

const INGEST: Node = { queue: "project.ingest", title: "Ingest", lines: ["yt-dlp or upload, ffprobe", "source stored once"] };
const TRANSCRIBE: Node = { queue: "project.transcribe", title: "Transcribe", lines: ["audio → chunks, in parallel", "checkpoint per chunk"] };
const REFINE: Node[] = [
  { queue: "refine.entities", title: "Entities", lines: ["names from your vocabulary"] },
  { queue: "refine.disfluency", title: "Disfluency", lines: ["fillers → verified jump cuts"] },
  { queue: "refine.scenes", title: "Scenes", lines: ["scene cuts and face presence"] },
];
const ANALYZE: Node = { queue: "project.analyze", title: "Pick moments", lines: ["map → pool → rank", "pairwise, judge model"] };
const RENDER: Node = { queue: "clip.render ×N", title: "Render", lines: ["layout, captions, hook", "intro, outro, one encode"] };

// geometry (viewBox units)
const W = 1112;
const H = 330;
const MAIN_H = 104;
const MID = 165;
const INGEST_X = 0;
const TRANSCRIBE_X = 196;
const REFINE_X = 456;
const ANALYZE_X = 716;
const RENDER_X = 912;
const MAIN_W = 164;
const REFINE_W = 200;
const REFINE_H = 58;
const REFINE_Y = [MID - 97 - REFINE_H / 2, MID - REFINE_H / 2, MID + 97 - REFINE_H / 2];
const RENDER_W = 184;

function MainNode({ n, x, w = MAIN_W }: { n: Node; x: number; w?: number }) {
  const y = MID - MAIN_H / 2;
  return (
    <g>
      <rect x={x} y={y} width={w} height={MAIN_H} rx="14" className="fill-panel stroke-line" strokeWidth="1.5" />
      <text x={x + 14} y={y + 24} className="fill-acc-text font-mono" fontSize="11">
        {n.queue}
      </text>
      <text x={x + 14} y={y + 48} className="fill-ink font-sans" fontSize="15" fontWeight="700">
        {n.title}
      </text>
      {n.lines.map((l, i) => (
        <text key={l} x={x + 14} y={y + 68 + i * 17} className="fill-ink2 font-sans" fontSize="11.5">
          {l}
        </text>
      ))}
    </g>
  );
}

function RefineNode({ n, i }: { n: Node; i: number }) {
  const y = REFINE_Y[i]!;
  return (
    <g>
      <rect x={REFINE_X} y={y} width={REFINE_W} height={REFINE_H} rx="12" className="fill-panel stroke-line" strokeWidth="1.5" />
      <text x={REFINE_X + 14} y={y + 21} className="fill-acc-text font-mono" fontSize="11">
        {n.queue}
      </text>
      <text x={REFINE_X + 14} y={y + 42} className="fill-ink2 font-sans" fontSize="11.5">
        {n.lines[0]}
      </text>
    </g>
  );
}

function RenderNode() {
  const y = MID - MAIN_H / 2;
  return (
    <g>
      {/* two cards behind: the ×N */}
      <rect x={RENDER_X + 16} y={y - 16} width={RENDER_W - 16} height={MAIN_H} rx="14" className="fill-sunk stroke-line" strokeWidth="1.5" />
      <rect x={RENDER_X + 8} y={y - 8} width={RENDER_W - 8} height={MAIN_H} rx="14" className="fill-sunk stroke-line" strokeWidth="1.5" />
      <MainNode n={RENDER} x={RENDER_X} w={RENDER_W} />
    </g>
  );
}

/** An edge: a muted base line plus an animated accent dash on top. */
function Edge({ d, delay = 0 }: { d: string; delay?: number }) {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} className="stroke-line2" strokeWidth="2" markerEnd="url(#arrow)" />
      <path d={d} className="pipeline-flow stroke-acc" strokeWidth="2" style={{ animationDelay: `${delay}s` }} />
    </g>
  );
}

const edges: { d: string; delay: number }[] = (() => {
  const out: { d: string; delay: number }[] = [];
  // ingest → transcribe
  out.push({ d: `M${INGEST_X + MAIN_W} ${MID} H${TRANSCRIBE_X - 6}`, delay: 0 });
  // transcribe → refine ×3 (fan-out through a bus at x = split)
  const split = TRANSCRIBE_X + MAIN_W + 28;
  REFINE_Y.forEach((y, i) => {
    const cy = y + REFINE_H / 2;
    out.push({ d: `M${TRANSCRIBE_X + MAIN_W} ${MID} H${split} V${cy} H${REFINE_X - 6}`, delay: 0.3 + i * 0.15 });
  });
  // refine ×3 → analyze (fan-in)
  const join = REFINE_X + REFINE_W + 28;
  REFINE_Y.forEach((y, i) => {
    const cy = y + REFINE_H / 2;
    out.push({ d: `M${REFINE_X + REFINE_W} ${cy} H${join} V${MID} H${ANALYZE_X - 6}`, delay: 0.9 + i * 0.15 });
  });
  // analyze → render
  out.push({ d: `M${ANALYZE_X + MAIN_W} ${MID} H${RENDER_X - 6}`, delay: 1.5 });
  return out;
})();

export function PipelineDiagram() {
  const stages = [INGEST, TRANSCRIBE, { queue: "refine.*", title: "Refine, in parallel", lines: REFINE.map((r) => `${r.queue}: ${r.lines[0]}`) }, ANALYZE, RENDER];
  return (
    <figure className="card overflow-hidden p-5 sm:p-6">
      <svg viewBox={`0 0 ${W} ${H}`} className="hidden w-full md:block" role="img" aria-labelledby="pipeline-title pipeline-desc">
        <title id="pipeline-title">The Reelsaw pipeline</title>
        <desc id="pipeline-desc">
          Ingest, then transcribe, then three refine jobs in parallel (entities, disfluency, scenes) that fan back in to pick moments, then one render job per clip. Every box is a pg-boss queue.
        </desc>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="fill-line2" />
          </marker>
        </defs>
        {edges.map((e) => (
          <Edge key={e.d} d={e.d} delay={e.delay} />
        ))}
        <MainNode n={INGEST} x={INGEST_X} />
        <MainNode n={TRANSCRIBE} x={TRANSCRIBE_X} />
        {REFINE.map((n, i) => (
          <RefineNode key={n.queue} n={n} i={i} />
        ))}
        <MainNode n={ANALYZE} x={ANALYZE_X} />
        <RenderNode />
        <text x={REFINE_X + REFINE_W / 2} y={H - 6} textAnchor="middle" className="fill-ink3 font-sans" fontSize="11">
          fan-out, fan-in on the transcript row; the last refine job to finish enqueues analyze
        </text>
      </svg>

      {/* phones: the same stages top to bottom */}
      <ol className="relative flex flex-col gap-3 md:hidden" aria-label="The Reelsaw pipeline">
        <span className="absolute top-3 bottom-3 left-[11px] w-px bg-line2" aria-hidden />
        {stages.map((n) => (
          <li key={n.queue} className="relative pl-8">
            <span className="absolute top-[7px] left-[7px] h-[9px] w-[9px] rounded-full bg-acc ring-4 ring-panel" aria-hidden />
            <span className="block font-mono text-[11px] text-acc-text">{n.queue}</span>
            <span className="block text-[15px] font-bold">{n.title}</span>
            {n.lines.map((l) => (
              <span key={l} className="block text-xs leading-relaxed text-ink2">
                {l}
              </span>
            ))}
          </li>
        ))}
      </ol>
      <figcaption className="mt-4 border-t border-line pt-3 text-center text-xs text-ink3">Every box is a pg-boss queue in Postgres. A stage checkpoints its output, so a restart resumes instead of starting over.</figcaption>
    </figure>
  );
}
