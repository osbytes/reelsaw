import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { openReport } from "../lib/report";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Modal, MoreButton, ProgressBar, StatusText } from "./ui";
import { ScrollArea } from "./scroll-area";
import { toast } from "sonner";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { formatNumber, formatTime, type ClipScores, type ClipDiagnostics, type ClipBumpers, type DetectedSegment } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { useDeletedToast } from "../lib/deletedToast";
import { ClipBumpersDialog } from "./BumperField";
import { ApplyTemplateToClipsDialog } from "./TemplatePicker";
import { useMe } from "../lib/account";
import { clipMeta, clipText } from "../lib/clipMeta";
import { summarizeError } from "../lib/errors";
import { MODE_LABEL } from "./Timeline";
import { ShareLinkDialog, useCopyShareLink } from "./ShareLinks";
import { DownloadClipButton } from "./DownloadClipButton";

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
  /** the clip's layers (the template dialog asks Replace / Keep when there are any) */
  layers?: unknown[] | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  /** the last render stored its captions: SRT / VTT can be downloaded */
  hasCaptions?: boolean;
  /** the last render burned the watermark in (hosted free accounts, or an admin's choice) */
  watermark?: boolean;
}

const RUBRIC: Array<{ key: keyof ClipScores; label: MessageDescriptor }> = [
  { key: "hook", label: msg`Hook` },
  { key: "value", label: msg`Value` },
  { key: "flow", label: msg`Flow` },
  { key: "shareability", label: msg`Shareability` },
  { key: "relevance", label: msg`Relevance` },
];

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
  projectIntroId?: string | null | undefined;
  projectOutroId?: string | null | undefined;
  selected?: boolean;
  /** some clip is selected: every card shows its checkbox */
  selecting?: boolean;
  onToggleSelect?: () => void;
  onCopyLink?: () => void;
  clip: ClipView;
  projectId: string;
  progress?: number | undefined;
  active?: boolean;
  busy?: boolean;
  onRerender: () => void;
  onSeek: () => void;
  onPlay: () => void;
}) {
  const { t, i18n } = useLingui();
  const [bdOpen, setBd] = useState(false);
  const [postOpen, setPost] = useState(false);
  const [bumpersOpen, setBumpersOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const copyShareLink = useCopyShareLink();
  const trpc = useTRPC();
  const del = useMutation(trpc.clips.delete.mutationOptions());
  const notifyDeleted = useDeletedToast();
  const deleteClip = () =>
    del.mutateAsync({ id: clip.id }).then(
      (r) =>
        notifyDeleted({
          items: [{ kind: "clip", id: clip.id, title: clip.title || t`Untitled clip` }],
          restorable: r.restorable,
          storedBytes: r.storedBytes,
        }),
      (err: Error) => {
        const reason = err.message.slice(0, 120);
        toast.error(t`Couldn’t delete the clip: ${reason}`);
      },
    );
  const isAdmin = useMe().data?.role === "admin";
  const done = clip.status === "done";
  const working = clip.status === "rendering" || clip.status === "preparing";
  const pct = Math.round((progress ?? 0) * 100);
  const tags = clip.hashtags.map((h) => `#${h}`).join(" ");
  const copy = (): Promise<void> =>
    navigator.clipboard
      .writeText(clipText(clip))
      .then(() => void toast(t`Title, caption + hashtags copied`))
      .catch(() => void toast.error(t`Couldn’t copy`));
  const meta = clipMeta(clip, { modeLabel: MODE_LABEL, projectHasIntro: !!projectIntroId, projectHasOutro: !!projectOutroId });
  const fail = clip.status === "failed" ? summarizeError(clip.error ?? t`Render failed`, { admin: isAdmin }) : null;
  const detail: { text: string; cls: string; title?: string | undefined } | null = fail
    ? { text: fail.summary, cls: "bg-err-soft", title: isAdmin ? (clip.error ?? undefined) : undefined }
    : clip.status === "pending"
      ? { text: t`Waiting for a render slot.`, cls: "bg-warn-soft" }
      : clip.status === "preparing"
        ? {
            text: clip.origin === "manual-ai" ? t`AI is finding the best moment in your selection.` : t`AI is writing the title, hook and caption.`,
            cls: "bg-acc-soft",
          }
        : null;
  const statusLabel =
    clip.status === "rendering" ? t`Rendering ${pct}%` : clip.status === "failed" ? t`Render failed` : clip.status === "pending" ? t`Queued` : undefined;
  const number = clip.index + 1;
  const rank = clip.scores?.rank;
  const statusKey = clip.status === "pending" ? "queued" : clip.status;
  const ghost =
    "inline-flex h-8 w-[5.25rem] items-center justify-center rounded-[8px] text-xs font-semibold no-underline disabled:cursor-not-allowed disabled:text-ink3 disabled:hover:bg-transparent";

  return (
    <article
      data-clip={clip.id}
      className={`group relative scroll-m-3 flex flex-col gap-2.5 rounded-[14px] border bg-panel p-3.5 ${clip.status === "failed" ? "border-err" : active || selected ? "border-acc" : "border-line"}`}
    >
      <div className="flex gap-3">
        {/* over the thumbnail's corner, not in the flow: the card looks the same with or without selection */}
        {onToggleSelect && (
          <span
            className={`absolute start-[18px] top-[18px] z-10 grid h-6 w-6 place-items-center rounded-[7px] bg-black/45 backdrop-blur-sm focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 ${selecting || selected ? "opacity-100" : "opacity-0"}`}
          >
            <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={t`Select clip ${number}`} className="h-4 w-4 accent-[var(--acc)]" />
          </span>
        )}
        <button
          onClick={onPlay}
          disabled={!clip.videoUrl}
          aria-label={t`Play preview`}
          className="film relative w-[64px] shrink-0 overflow-hidden rounded-[8px] disabled:cursor-default"
          style={{ aspectRatio: "9 / 16" }}
        >
          {clip.thumbnailUrl && <img src={clip.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full bg-black object-contain" />}
          <span className="absolute inset-0 grid place-items-center font-mono text-[11px] text-white [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
            {clip.status === "failed" ? (
              "!"
            ) : clip.status === "preparing" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : working ? (
              `${pct}%`
            ) : clip.status === "pending" ? (
              "◷"
            ) : (
              <span className="grid h-6 w-6 place-items-center rounded-full bg-white/90 text-[9px] text-film-ink">▶</span>
            )}
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
            <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug">{clip.title || t`Untitled clip`}</h3>
            {clip.watermark && done && (
              <span className="shrink-0 pt-px font-mono text-[11px] text-ink3" title={t`Rendered with the watermark; a re-render after an upgrade removes it`}>
                <Trans comment="short badge: rendered with the watermark">◇ wm</Trans>
              </span>
            )}
            {clip.score > 0 && (
              <button
                onClick={() => setBd(!bdOpen)}
                aria-expanded={bdOpen}
                title={t`Why this score`}
                className={`shrink-0 rounded-[8px] px-2 py-0.5 font-mono text-[13px] font-semibold ${bdOpen ? "bg-acc text-acc-ink" : "bg-acc-soft text-acc-text"}`}
              >
                {Math.round(clip.score)}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink2">
            <button onClick={onSeek} className="font-mono text-ink2 hover:text-acc-text" title={t`Seek source to this clip`}>
              {formatTime(clip.startSec)}–{formatTime(clip.endSec)}
            </button>
            <span>{formatNumber(Math.round(clip.endSec - clip.startSec))}s</span>
            <StatusText status={statusKey as never} label={statusLabel} />
          </div>
          {clip.origin && clip.origin !== "ai" && (
            <span className="w-max rounded-full bg-sunk px-2 py-px text-[11px] font-semibold text-ink2">
              {clip.origin === "manual" ? t`Your range` : t`AI pick in your range`}
            </span>
          )}
          {clip.hook && <p className="text-[13px] text-ink2">“{clip.hook}”</p>}
        </div>
      </div>

      {clip.status === "rendering" && <ProgressBar value={progress ?? 0} />}
      {detail && (
        <div className={`rounded-[8px] px-2.5 py-1.5 text-xs leading-snug text-ink ${detail.cls}`} title={detail.title}>
          {detail.text}
        </div>
      )}

      {bdOpen && (
        <div className="flex flex-col gap-1.5 rounded-[10px] bg-sunk p-2.5">
          {clip.scores ? (
            RUBRIC.filter((r) => clip.scores![r.key] !== undefined).map((r) => {
              const v = Math.round((clip.scores![r.key] as number) * 10);
              return (
                <div key={r.key} className="grid grid-cols-[92px_1fr_28px] items-center gap-2 text-xs">
                  <span className="text-ink2">{i18n._(r.label)}</span>
                  <div className="h-1.5 rounded-full bg-line">
                    <div className="h-full rounded-full bg-acc" style={{ width: `${v}%` }} />
                  </div>
                  <span className="text-end font-mono">{v}</span>
                </div>
              );
            })
          ) : (
            <span className="text-xs text-ink2">
              <Trans>No breakdown stored for this clip.</Trans>
            </span>
          )}
          {clip.reasoning && <p className="mt-0.5 text-xs leading-snug text-ink2">{clip.reasoning}</p>}
          {clip.scores?.rank ? (
            <p className="text-[11px] text-ink3">
              <Trans>Ranked #{rank} in head-to-head comparisons. A rubric score, not a view prediction.</Trans>
            </p>
          ) : null}
        </div>
      )}

      {/* one line, always present so the card keeps its height; the full facts are in the tooltip */}
      <p className={`h-4 truncate text-xs leading-4 ${meta.warn ? "text-warn" : "text-ink3"}`} title={meta.title || undefined}>
        {clip.status === "preparing" ? "" : meta.text}
      </p>

      <div className="-mx-1 flex h-8 items-center gap-0.5">
        {clip.status === "failed" && (
          <button className="btn-ink me-1 h-8 px-2.5 text-xs" disabled={busy} onClick={onRerender}>
            <Trans>↻ Retry</Trans>
          </button>
        )}
        <Link
          to={`/p/${projectId}/clips/${clip.id}`}
          aria-disabled={clip.status === "preparing"}
          className={`${ghost} text-acc-text hover:bg-acc-soft ${clip.status === "preparing" ? "pointer-events-none opacity-50" : ""}`}
        >
          <Trans>Edit</Trans>
        </Link>
        {done && clip.videoUrl ? (
          <DownloadClipButton
            clip={{ id: clip.id, videoUrl: clip.videoUrl, watermark: clip.watermark }}
            projectId={projectId}
            className={`${ghost} text-ink hover:bg-sunk`}
          />
        ) : (
          <button className={`${ghost} text-ink`} disabled title={t`Available once the clip is rendered`}>
            <Trans>Download</Trans>
          </button>
        )}
        <div className="flex-1" />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <MoreButton aria-label={t`More actions for clip ${number}`} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[220px]">
              {/* grouped: what to post (text, links), files, how it renders, then the rest */}
              <DropdownMenu.Item className="menu-item" onSelect={() => void copy()}>
                <Trans>Copy text</Trans>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => setPost(true)}>
                <Trans>Caption &amp; hashtags…</Trans>
              </DropdownMenu.Item>
              {onCopyLink && (
                <DropdownMenu.Item className="menu-item" onSelect={onCopyLink}>
                  <Trans>Copy page link</Trans>
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item
                className="menu-item"
                disabled={!done}
                title={done ? t`A link anyone can download this clip from, without signing in` : t`Available once the clip is rendered`}
                onSelect={() => copyShareLink({ kind: "clip", clipId: clip.id })}
              >
                <Trans>Copy share link</Trans>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" disabled={!done} onSelect={() => setShareOpen(true)}>
                <Trans>Share link options…</Trans>
              </DropdownMenu.Item>
              {clip.hasCaptions && <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />}
              {clip.hasCaptions &&
                (["srt", "vtt"] as const).map((f) => {
                  const format = f.toUpperCase();
                  return (
                    <DropdownMenu.Item key={f} className="menu-item" asChild>
                      <a href={`/api/clips/${clip.id}/captions.${f}`} download>
                        <Trans>Download captions ({format})</Trans>
                      </a>
                    </DropdownMenu.Item>
                  );
                })}
              <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
              <DropdownMenu.Item className="menu-item" disabled={working || busy || clip.status === "preparing"} onSelect={onRerender}>
                <Trans>Re-render</Trans>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" disabled={clip.status === "preparing"} onSelect={() => setBumpersOpen(true)}>
                <Trans>Intro and outro…</Trans>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" disabled={clip.status === "preparing"} onSelect={() => setTemplateOpen(true)}>
                <Trans>Layer template…</Trans>
              </DropdownMenu.Item>
              {clip.status === "failed" && (
                <DropdownMenu.Item className="menu-item" onSelect={() => openReport({ projectId, clipId: clip.id })}>
                  <Trans>Report an issue…</Trans>
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
              {/* a soft delete: it happens at once and the toast's Undo brings it back, so no dialog first */}
              <DropdownMenu.Item className="menu-item-danger" disabled={del.isPending} onSelect={deleteClip}>
                <Trans>Delete clip</Trans>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <Modal open={postOpen} onOpenChange={setPost} title={t`Clip ${number}: caption & hashtags`} width={440}>
        <Dialog.Description className="sr-only">
          <Trans>The caption and hashtags to post with this clip.</Trans>
        </Dialog.Description>
        <ScrollArea className="max-h-[min(60dvh,calc(90dvh-8rem))]">
          <div className="flex flex-col gap-1.5 rounded-[10px] bg-sunk p-3 text-[13px] leading-snug">
            <div className="font-semibold">{clip.title}</div>
            <div>
              {clip.caption || (
                <span className="text-ink3">
                  <Trans>No caption</Trans>
                </span>
              )}
            </div>
            {tags && <div className="text-xs text-acc-text">{tags}</div>}
          </div>
        </ScrollArea>
        <div className="flex shrink-0 justify-end gap-2">
          <button className="btn-ghost" onClick={() => setPost(false)}>
            <Trans>Close</Trans>
          </button>
          <button className="btn-ink" onClick={() => void copy().then(() => setPost(false))}>
            <Trans>Copy</Trans>
          </button>
        </div>
      </Modal>
      {shareOpen && <ShareLinkDialog open={shareOpen} onOpenChange={setShareOpen} target={{ kind: "clip", clipId: clip.id }} what={t`this clip`} />}
      <ClipBumpersDialog
        open={bumpersOpen}
        onOpenChange={setBumpersOpen}
        clipId={clip.id}
        projectId={projectId}
        bumpers={clip.bumpers}
        rendered={clip.status === "done" || clip.status === "failed"}
        projectIntroId={projectIntroId}
        projectOutroId={projectOutroId}
      />
      <ApplyTemplateToClipsDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        projectId={projectId}
        clipIds={[clip.id]}
        withLayers={clip.layers?.length ?? 0}
        rerenderable={clip.status === "done" || clip.status === "failed" ? 1 : 0}
      />
    </article>
  );
}
