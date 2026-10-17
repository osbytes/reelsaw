import { useState } from "react";
import { Link } from "react-router";
import { Loader2 } from "lucide-react";
import { openReport } from "../lib/report";
import { ProgressBar, StatusText } from "./ui";
import { toast } from "sonner";
import { formatTime, type ClipScores, type ClipDiagnostics, type ClipBumpers, type DetectedSegment } from "@reelsaw/shared";
import { ClipBumpersPopover } from "./BumperField";
import { MODE_LABEL } from "./Timeline";

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
  layoutSections?: Array<{ mode: string }>;
  layoutSegments?: DetectedSegment[];
  scores?: ClipScores | null;
  diagnostics?: ClipDiagnostics | null;
  bumpers?: ClipBumpers | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

const RUBRIC: Array<{ key: keyof ClipScores; label: string }> = [
  { key: "hook", label: "Hook" },
  { key: "value", label: "Value" },
  { key: "flow", label: "Flow" },
  { key: "shareability", label: "Shareability" },
  { key: "relevance", label: "Relevance" },
];

function framingText(c: ClipView) {
  const segs = c.layoutSegments ?? [];
  const forced = (c.layoutSections?.length ?? 0) > 0 || (c.layoutOverride && c.layoutOverride !== "auto");
  if (!segs.length) return c.layout ? `${forced ? "" : "Auto · "}${MODE_LABEL[c.layout] ?? c.layout}` : "Decided at render";
  const names: string[] = [];
  for (const s of segs) {
    const n = MODE_LABEL[s.layout] ?? s.layout;
    if (names.at(-1) !== n) names.push(n);
  }
  return `${forced ? "" : "Auto · "}${names.join(" → ")}${forced ? " (set)" : ""}`;
}

function cutsNote(d: ClipDiagnostics | null | undefined) {
  if (!d) return "Shown after the first render";
  const a = d.cuts.applied.length;
  const k = d.cuts.skipped.length;
  const parts: string[] = [];
  if (a || k) parts.push(`${a} cut${a === 1 ? "" : "s"}${k ? `; ${k} kept because removal couldn’t be verified` : ""}`);
  if (d.pauses?.cuts) parts.push(`${d.pauses.removedSec.toFixed(1)}s of pauses trimmed`);
  return parts.length ? parts.join(" · ") : "No disfluencies found";
}

/** What the last render attached: lengths, none, or which part was skipped (glyph plus word, never colour alone), and whose choice it was. */
function bumpersNote(d: ClipDiagnostics | null | undefined): { text: string; skipped: boolean; title?: string } {
  if (!d) return { text: "Shown after the first render", skipped: false };
  const b = d.bumpers;
  const who = b?.fromClip?.length ? "set for this clip" : "project default";
  if (!b) return { text: "None", skipped: false };
  const skipped = (b.skipped ?? []).map((s) => (s.startsWith("outro") ? "Outro" : "Intro"));
  const parts = [b.introSec ? `+ intro ${b.introSec.toFixed(0)} s` : "", b.outroSec ? `+ outro ${b.outroSec.toFixed(0)} s` : ""].filter(Boolean);
  if (skipped.length) return { text: `▲ ${[...new Set(skipped)].join(" and ")} skipped${parts.length ? ` · kept ${parts.join(", ")}` : ""}`, skipped: true, title: (b.skipped ?? []).join("; ") };
  return { text: parts.length ? `${parts.join(" · ")} · ${who}` : b.fromClip?.length ? "None · set for this clip" : "None", skipped: false };
}

export function ClipCard({
  clip,
  projectId,
  progress,
  active,
  busy,
  onRerender,
  onSeek,
  onPlay,
  onCopyLink,
  projectIntroId,
  projectOutroId,
  selected = false,
  selecting = false,
  onToggleSelect,
}: {
  projectIntroId?: string | null;
  projectOutroId?: string | null;
  selected?: boolean;
  /** some clip is selected: every card shows its checkbox */
  selecting?: boolean;
  onToggleSelect?: () => void;
  onCopyLink?: () => void;
  clip: ClipView;
  projectId: string;
  progress?: number;
  active?: boolean;
  busy?: boolean;
  onRerender: () => void;
  onSeek: () => void;
  onPlay: () => void;
}) {
  const [bdOpen, setBd] = useState(false);
  const [postOpen, setPost] = useState(false);
  const [whyOpen, setWhy] = useState(false);
  const done = clip.status === "done";
  const working = clip.status === "rendering" || clip.status === "preparing";
  const pct = Math.round((progress ?? 0) * 100);
  const tags = clip.hashtags.map((h) => `#${h}`).join(" ");
  const copy = () =>
    navigator.clipboard
      .writeText([clip.title, clip.caption, tags].filter(Boolean).join("\n\n"))
      .then(() => toast("Caption + hashtags copied"))
      .catch(() => toast.error("Couldn’t copy"));
  const skipped = clip.diagnostics?.cuts.skipped ?? [];
  const bumpers = bumpersNote(clip.diagnostics);
  const detail =
    clip.status === "failed"
      ? { text: clip.error ?? "Render failed", cls: "bg-err-soft" }
      : clip.status === "pending"
        ? { text: "Waiting for a render slot.", cls: "bg-warn-soft" }
        : clip.status === "preparing"
          ? { text: clip.origin === "manual-ai" ? "AI is finding the best moment in your selection." : "AI is writing the title, hook and caption.", cls: "bg-acc-soft" }
          : null;
  const statusLabel = clip.status === "rendering" ? `Rendering ${pct}%` : clip.status === "failed" ? "Render failed" : clip.status === "pending" ? "Queued" : undefined;
  const statusKey = clip.status === "pending" ? "queued" : clip.status;
  const ghost = "rounded-[8px] px-2.5 py-1.5 text-xs text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:text-ink3 disabled:hover:bg-transparent";

  return (
    <article data-clip={clip.id} className={`group relative scroll-m-3 flex flex-col gap-2.5 rounded-[14px] border bg-panel p-3.5 ${clip.status === "failed" ? "border-err" : active || selected ? "border-acc" : "border-line"}`}>
      <div className="flex gap-3">
        {/* over the thumbnail's corner, not in the flow: the card looks the same with or without selection */}
        {onToggleSelect && (
          <span className={`absolute left-[18px] top-[18px] z-10 grid h-6 w-6 place-items-center rounded-[7px] bg-black/45 backdrop-blur-sm focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 ${selecting || selected ? "opacity-100" : "opacity-0"}`}>
            <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select clip ${clip.index + 1}`} className="h-4 w-4 accent-[var(--acc)]" />
          </span>
        )}
        <button onClick={onPlay} disabled={!clip.videoUrl} aria-label="Play preview" className="film relative w-[64px] shrink-0 overflow-hidden rounded-[8px] disabled:cursor-default" style={{ aspectRatio: "9 / 16" }}>
          {clip.thumbnailUrl && <img src={clip.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          <span className="absolute inset-0 grid place-items-center font-mono text-[11px] text-white [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
            {clip.status === "failed" ? "!" : clip.status === "preparing" ? <Loader2 className="h-4 w-4 animate-spin" /> : working ? `${pct}%` : clip.status === "pending" ? "◷" : <span className="grid h-6 w-6 place-items-center rounded-full bg-white/90 text-[9px] text-[#1c1c1e]">▶</span>}
          </span>
          {clip.status === "rendering" && (
            <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30">
              <span className="block h-full bg-acc" style={{ width: `${pct}%` }} />
            </span>
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start gap-2">
            <span className="pt-px font-mono text-xs text-ink3">#{clip.index + 1}</span>
            <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug">{clip.title || "Untitled moment"}</h3>
            {clip.score > 0 && (
              <button
                onClick={() => setBd(!bdOpen)}
                aria-expanded={bdOpen}
                title="Why this score"
                className={`shrink-0 rounded-[8px] px-2 py-0.5 font-mono text-[13px] font-semibold ${bdOpen ? "bg-acc text-acc-ink" : "bg-acc-soft text-acc-text"}`}
              >
                {Math.round(clip.score)}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink2">
            <button onClick={onSeek} className="font-mono text-ink2 hover:text-acc-text" title="Seek source to this clip">
              {formatTime(clip.startSec)}–{formatTime(clip.endSec)}
            </button>
            <span>{Math.round(clip.endSec - clip.startSec)}s</span>
            <StatusText status={statusKey as never} label={statusLabel} />
          </div>
          {clip.origin && clip.origin !== "ai" && <span className="w-max rounded-full bg-sunk px-2 py-px text-[11px] font-semibold text-ink2">{clip.origin === "manual" ? "Your range" : "AI pick in your range"}</span>}
          {clip.hook && <p className="text-[13px] text-ink2">“{clip.hook}”</p>}
        </div>
      </div>

      {clip.status === "rendering" && <ProgressBar value={progress ?? 0} />}
      {detail && <div className={`rounded-[8px] px-2.5 py-1.5 text-xs leading-snug text-ink ${detail.cls}`}>{detail.text}</div>}

      {bdOpen && (
        <div className="flex flex-col gap-1.5 rounded-[10px] bg-sunk p-2.5">
          {clip.scores ? (
            RUBRIC.filter((r) => clip.scores![r.key] !== undefined).map((r) => {
              const v = Math.round((clip.scores![r.key] as number) * 10);
              return (
                <div key={r.key} className="grid grid-cols-[92px_1fr_28px] items-center gap-2 text-xs">
                  <span className="text-ink2">{r.label}</span>
                  <div className="h-1.5 rounded-full bg-line">
                    <div className="h-full rounded-full bg-acc" style={{ width: `${v}%` }} />
                  </div>
                  <span className="text-right font-mono">{v}</span>
                </div>
              );
            })
          ) : (
            <span className="text-xs text-ink2">No breakdown stored for this clip.</span>
          )}
          {clip.reasoning && <p className="mt-0.5 text-xs leading-snug text-ink2">{clip.reasoning}</p>}
          {clip.scores?.rank ? <p className="text-[11px] text-ink3">Ranked #{clip.scores.rank} in head-to-head comparisons. A rubric score, not a view prediction.</p> : null}
        </div>
      )}

      {clip.status !== "preparing" && (
        <dl className="grid grid-cols-[76px_1fr] gap-x-2 gap-y-1 text-xs">
          <dt className="text-ink3">Framing</dt>
          <dd className="text-ink">{framingText(clip)}</dd>
          <dt className="text-ink3">Intro/outro</dt>
          <dd className={bumpers.skipped ? "font-semibold text-warn" : "text-ink"} title={bumpers.title}>
            {bumpers.text}
          </dd>
          <dt className="text-ink3">Cuts</dt>
          <dd className="text-ink">
            {cutsNote(clip.diagnostics)}{" "}
            {skipped.length > 0 && (
              <button className="font-semibold text-acc-text" onClick={() => setWhy(!whyOpen)}>
                {whyOpen ? "Hide" : "Why?"}
              </button>
            )}
          </dd>
          <dt className="text-ink3">Post</dt>
          <dd>
            <button className="font-semibold text-acc-text" aria-expanded={postOpen} onClick={() => setPost(!postOpen)}>
              {postOpen ? "Hide caption & hashtags" : "Show caption & hashtags"}
            </button>
          </dd>
        </dl>
      )}
      {whyOpen && (
        <div className="rounded-[8px] bg-warn-soft px-2.5 py-1.5 text-xs leading-snug">
          The removal couldn’t be verified, so the audio was kept. Captions still drop the word.
          {skipped.map((s, i) => (
            <p key={i} className="mt-1 line-clamp-3 font-mono text-[10px] text-ink2" title={s.reason}>
              {formatTime(s.start)} · {s.reason}
            </p>
          ))}
        </div>
      )}
      {postOpen && (
        <div className="flex flex-col gap-1 rounded-[10px] bg-sunk p-2.5 text-[13px] leading-snug">
          <div>{clip.caption || <span className="text-ink3">No caption</span>}</div>
          {tags && <div className="text-xs text-acc-text">{tags}</div>}
        </div>
      )}

      <div className="-mx-1 flex flex-wrap items-center gap-0.5">
        {clip.status === "failed" && (
          <>
            <button className="btn-ink mr-1 px-2.5 py-1.5 text-xs" disabled={busy} onClick={onRerender}>
              ↻ Retry render
            </button>
            <button className="rounded-[8px] px-2.5 py-1.5 text-xs font-semibold text-err hover:bg-err-soft" onClick={() => openReport({ projectId, clipId: clip.id })}>
              Report
            </button>
          </>
        )}
        <Link
          to={`/p/${projectId}/clips/${clip.id}`}
          aria-disabled={clip.status === "preparing"}
          className={`rounded-[8px] px-2.5 py-1.5 text-xs font-semibold text-acc-text no-underline hover:bg-acc-soft ${clip.status === "preparing" ? "pointer-events-none opacity-50" : ""}`}
        >
          Edit
        </Link>
        <button className={ghost} onClick={copy}>
          Copy text
        </button>
        {onCopyLink && (
          <button className={ghost} onClick={onCopyLink} title="Copy a link that opens this clip">
            Link
          </button>
        )}
        {done && clip.videoUrl ? (
          <a className={`${ghost} no-underline`} href={`${clip.videoUrl}?download`}>
            Download
          </a>
        ) : (
          <button className={ghost} disabled>
            Download
          </button>
        )}
        <button className={ghost} disabled={working || busy} onClick={onRerender}>
          Re-render
        </button>
        <ClipBumpersPopover clipId={clip.id} projectId={projectId} bumpers={clip.bumpers} rendered={clip.status === "done" || clip.status === "failed"} projectIntroId={projectIntroId} projectOutroId={projectOutroId} className={ghost} />
      </div>
    </article>
  );
}
