import { useState } from "react";
import { Download, RefreshCw, Scissors, Loader2, Copy, Check, Crosshair } from "lucide-react";
import { StatusBadge, ProgressBar } from "./ui";
import * as Popover from "@radix-ui/react-popover";
import { formatTime, RUBRIC_WEIGHTS, type ClipScores, type ClipDiagnostics } from "@reelsaw/shared";

export interface ClipView {
  id: string;
  index: number;
  title: string;
  hook: string;
  caption: string;
  startSec: number;
  endSec: number;
  score: number;
  reasoning: string;
  hashtags: string[];
  status: "preparing" | "pending" | "rendering" | "done" | "failed";
  origin?: "ai" | "manual" | "manual-ai";
  error: string | null;
  layout: string | null;
  layoutInfo: { reason: string } | null;
  layoutOverride: string | null;
  layoutSections?: unknown[];
  scores?: ClipScores | null;
  diagnostics?: ClipDiagnostics | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

const LAYOUT_LABEL: Record<string, string> = { face: "Face crop", split: "Split", stack: "Stacked", fit: "Fit", center: "Center", none: "Original" };

function scoreColor(s: number) {
  return s >= 80 ? "text-ok" : s >= 60 ? "text-accent" : "text-muted";
}

export function ClipCard({
  clip,
  progress,
  active,
  busy,
  onEdit,
  onRerender,
  onSeek,
}: {
  clip: ClipView;
  progress?: number;
  active?: boolean;
  busy?: boolean;
  onEdit: () => void;
  onRerender: () => void;
  onSeek: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const postText = [clip.caption || clip.title, clip.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n");
  const copy = () => {
    void navigator.clipboard.writeText(postText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const len = Math.round(clip.endSec - clip.startSec);

  return (
    <div className={`card flex gap-4 p-3 transition ${active ? "border-accent/60" : ""}`}>
      {/* player */}
      <div className="relative w-[200px] shrink-0 overflow-hidden rounded-md bg-black" style={{ aspectRatio: "9 / 16" }}>
        {clip.videoUrl ? (
          <video src={clip.videoUrl} poster={clip.thumbnailUrl ?? undefined} controls preload="metadata" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-xs text-muted">
            {clip.status === "rendering" || clip.status === "preparing" ? <Loader2 className={`h-5 w-5 animate-spin ${clip.status === "preparing" ? "text-accent-2" : "text-accent"}`} /> : <StatusBadge status={clip.status} />}
            {clip.status === "preparing" && <p className="text-center">{clip.origin === "manual-ai" ? "AI is finding the best moment in your selection" : "AI is writing the title, hook and caption"}</p>}
            {(clip.status === "rendering" || clip.status === "preparing") && (
              <div className="w-full">
                <ProgressBar value={progress ?? 0} />
              </div>
            )}
            {clip.error && <p className="line-clamp-4 text-center text-danger">{clip.error}</p>}
          </div>
        )}
        <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-muted">#{clip.index + 1}</span>
      </div>

      {/* meta */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold leading-snug">{clip.title}</h3>
          <ScoreBadge score={clip.score} scores={clip.scores ?? null} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <button className="flex items-center gap-1 hover:text-text" onClick={onSeek} title="Jump the source player to this clip">
            <Crosshair className="h-3 w-3" /> {formatTime(clip.startSec)} → {formatTime(clip.endSec)} · {len}s
          </button>
          {clip.layout && (
            <span className="rounded bg-panel-2 px-1.5 py-0.5" title={clip.layoutInfo?.reason ?? ""}>
              {LAYOUT_LABEL[clip.layout] ?? clip.layout}
              {clip.layoutOverride || clip.layoutSections?.length ? " · manual" : ""}
            </span>
          )}
          {clip.diagnostics && (clip.diagnostics.cuts.applied.length + clip.diagnostics.cuts.skipped.length > 0 || (clip.diagnostics.pauses?.cuts ?? 0) > 0) && <CutsBadge d={clip.diagnostics} />}
          {clip.origin && clip.origin !== "ai" && (
            <span className="rounded bg-accent-2/15 px-1.5 py-0.5 text-accent-2" title={clip.origin === "manual" ? "Exact range you selected in the transcript" : "AI picked this inside your transcript selection"}>
              {clip.origin === "manual" ? "Your selection" : "AI pick from selection"}
            </span>
          )}
        </div>
        {clip.hook && <p className="text-sm text-accent-2">“{clip.hook}”</p>}
        {clip.caption && <p className="text-sm text-text/90">{clip.caption}</p>}
        {clip.hashtags.length > 0 && <p className="text-xs text-muted">{clip.hashtags.map((h) => `#${h}`).join(" ")}</p>}
        <p className="line-clamp-2 text-xs text-muted/80" title={clip.reasoning}>
          {clip.reasoning}
        </p>
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {clip.videoUrl && (
            <a className="btn-primary" href={`${clip.videoUrl}?download`}>
              <Download className="h-4 w-4" /> Download
            </a>
          )}
          <button className="btn-ghost" disabled={clip.status === "preparing"} onClick={onEdit} title="Trim, retitle, change layout">
            <Scissors className="h-4 w-4" /> Edit
          </button>
          <button className="btn-ghost" onClick={copy} title="Copy caption + hashtags">
            {copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />} Caption
          </button>
          <button className="btn-ghost" disabled={clip.status === "rendering" || clip.status === "preparing" || busy} onClick={onRerender} title="Re-render">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

const RUBRIC: Array<{ key: keyof typeof RUBRIC_WEIGHTS | "relevance"; label: string; hint: string }> = [
  { key: "hook", label: "Hook", hint: "Does the opening stop a scroller within 3 seconds?" },
  { key: "value", label: "Value", hint: "Insight, emotion, humour, story or usefulness" },
  { key: "flow", label: "Flow", hint: "Stands alone: clean start, payoff at the end" },
  { key: "shareability", label: "Share", hint: "Would people comment, share or save it?" },
  { key: "relevance", label: "Focus", hint: "How on-topic it is for your focus" },
];

/** Total score; click for the rubric breakdown it was computed from. */
function ScoreBadge({ score, scores }: { score: number; scores: ClipScores | null }) {
  const badge = (
    <div className={`shrink-0 text-right ${scoreColor(score)}`}>
      <div className="text-lg font-bold leading-none">{Math.round(score)}</div>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{scores?.rank ? `score · #${scores.rank} h2h` : "score"}</div>
    </div>
  );
  if (!scores) return badge;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="rounded hover:bg-panel-2" title="Score breakdown">
          {badge}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="left" align="start" sideOffset={6} className="z-50 w-64 space-y-2 rounded-md border border-border bg-panel p-3 text-xs shadow-xl outline-none">
          {RUBRIC.filter((r) => scores[r.key] !== undefined).map((r) => {
            const v = scores[r.key] as number;
            return (
              <div key={r.key} title={r.hint}>
                <div className="flex justify-between">
                  <span>{r.label}</span>
                  <span className="font-mono text-muted">{v.toFixed(1)}/10</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-panel-2">
                  <div className={`h-full ${v >= 7 ? "bg-ok" : v >= 5 ? "bg-accent" : "bg-muted"}`} style={{ width: `${v * 10}%` }} />
                </div>
              </div>
            );
          })}
          <p className="pt-1 text-muted">
            Weighted: hook {RUBRIC_WEIGHTS.hook * 100}%, value {RUBRIC_WEIGHTS.value * 100}%, flow {RUBRIC_WEIGHTS.flow * 100}%, share {RUBRIC_WEIGHTS.shareability * 100}%. Median of {scores.samples} judgement(s).
            {scores.rank ? ` Ranked #${scores.rank} in head-to-head comparisons.` : ""} A rubric score, not a view prediction.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Disfluency cuts the last render applied / refused, with the verifier's reasons. */
function CutsBadge({ d }: { d: ClipDiagnostics }) {
  const skipped = d.cuts.skipped.length;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={`rounded px-1.5 py-0.5 ${skipped ? "bg-accent/15 text-accent" : "bg-panel-2"}`} title="Disfluency jump cuts in the last render">
          ✂ {d.cuts.applied.length} cut{d.cuts.applied.length === 1 ? "" : "s"}
          {skipped ? ` · ${skipped} kept` : ""}
          {d.pauses?.cuts ? ` · ${d.pauses.removedSec.toFixed(1)}s pauses` : ""}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={6} className="z-50 max-w-md space-y-2 rounded-md border border-border bg-panel p-3 text-xs shadow-xl outline-none">
          {d.pauses?.cuts ? (
            <p>
              Shortened {d.pauses.cuts} pause{d.pauses.cuts === 1 ? "" : "s"} to {d.pauses.maxPause}s, {d.pauses.removedSec.toFixed(1)}s of silence removed.
            </p>
          ) : null}
          {d.cuts.applied.map((c, i) => (
            <p key={`a${i}`} className="text-ok">
              Cut {formatTime(c.start)} ({(c.end - c.start).toFixed(2)}s), verified by re-transcribing the seam
            </p>
          ))}
          {d.cuts.skipped.map((c, i) => (
            <div key={`s${i}`}>
              <p className="text-accent">Kept {formatTime(c.start)}: the removal could not be verified, so the audio was left intact (captions still drop it).</p>
              <p className="mt-1 line-clamp-6 break-words font-mono text-[10px] text-muted" title={c.reason}>
                {c.reason}
              </p>
            </div>
          ))}
          <p className="text-muted">
            Rendered {new Date(d.renderedAt).toLocaleString()} in {(d.renderMs / 1000).toFixed(0)}s · {d.outDurationSec}s output
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
