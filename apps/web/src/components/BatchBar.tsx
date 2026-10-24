import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { clipsText } from "../lib/clipMeta";
import { BulkBumpersPopover } from "./BumperField";
import { BulkTemplateButton } from "./TemplatePicker";

interface BatchClip {
  id: string;
  title: string;
  caption: string;
  hashtags: string[];
  status: "preparing" | "pending" | "rendering" | "done" | "failed";
  /** the clip's layers (only the count matters here: the template dialog asks Replace / Keep when some clip has any) */
  layers?: unknown[] | null;
}

const slot = "inline-flex h-8 min-w-0 items-center justify-center truncate rounded-[8px] px-1.5 text-xs font-semibold no-underline disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The selection's actions, sticky at the bottom of the clips list. Two fixed lines (a status line, then five button
 * slots) so it is the same height at every width and whatever the selection holds. A button that does not apply stays
 * in its slot, disabled, with a title that says why.
 */
export function BatchBar({ projectId, selected, introId, outroId, onClear, onChanged }: { projectId: string; selected: BatchClip[]; introId?: string | null; outroId?: string | null; onClear: () => void; onChanged: () => void }) {
  const trpc = useTRPC();
  const many = useMutation(trpc.clips.rerenderMany.mutationOptions());
  const done = selected.filter((c) => c.status === "done");
  const failed = selected.filter((c) => c.status === "failed");
  const renderable = selected.filter((c) => c.status === "done" || c.status === "failed");
  const run = (clips: BatchClip[], what: string) =>
    many.mutate(
      { projectId, clipIds: clips.map((c) => c.id) },
      {
        onSuccess: (r) => {
          onChanged();
          toast(`${what} ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} skipped (still rendering)` : ""}`);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  const copyAll = () =>
    navigator.clipboard
      .writeText(clipsText(selected))
      .then(() => toast(`Title, caption + hashtags of ${selected.length} clip${selected.length === 1 ? "" : "s"} copied`))
      .catch(() => toast.error("Couldn’t copy"));
  const n = (k: number) => `${k} clip${k === 1 ? "" : "s"}`;
  const exportHref = `/api/projects/${projectId}/export.zip?clips=${done.map((c) => c.id).join(",")}`;
  const btn = `${slot} btn-ghost`;

  return (
    <div role="region" aria-label="Selected clips" className="sticky bottom-0 z-10 flex flex-col gap-1.5 border-t border-line bg-panel px-3 py-2 shadow-pop">
      <div className="flex h-8 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-semibold" aria-live="polite">
          <span aria-hidden className="mr-1 font-mono text-acc-text">
            ✓
          </span>
          {selected.length} selected
          <span className="ml-1.5 font-normal text-ink3">
            {done.length} rendered{failed.length ? ` · ${failed.length} failed` : ""}
          </span>
        </span>
        {/* keeps its slot when nothing failed, so the line does not shift */}
        <button className={`${slot} w-[8.5rem] shrink-0 text-err hover:bg-err-soft ${failed.length ? "" : "invisible"}`} disabled={many.isPending} title={`Re-render the ${n(failed.length)} that failed`} onClick={() => run(failed, "Retrying")}>
          ▲ Retry failed {failed.length}
        </button>
        <button className="text-xs font-semibold text-acc-text" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="grid h-8 grid-cols-[1fr_0.8fr_1fr_1.35fr_1.15fr] gap-1">
        <button className={btn} disabled={!renderable.length || many.isPending} title={renderable.length ? `Re-render ${n(renderable.length)}` : "None of the selected clips is rendered or failed"} aria-label={`Re-render ${n(renderable.length)}`} onClick={() => run(renderable, "Re-rendering")}>
          Re-render
        </button>
        {done.length ? (
          <a className={btn} href={exportHref} title={`Download a zip of ${n(done.length)} with YouTube and TikTok metadata`} aria-label={`Export ${n(done.length)}`}>
            Export
          </a>
        ) : (
          <button className={btn} disabled title="None of the selected clips is rendered yet" aria-label="Export (no rendered clip selected)">
            Export
          </button>
        )}
        <button className={btn} title={`Copy the title, caption and hashtags of ${n(selected.length)}`} aria-label={`Copy text of ${n(selected.length)}`} onClick={() => void copyAll()}>
          Copy text
        </button>
        <BulkBumpersPopover projectId={projectId} clipIds={selected.map((c) => c.id)} rerenderable={renderable.length} projectIntroId={introId} projectOutroId={outroId} onDone={onChanged} className={btn} />
        <BulkTemplateButton projectId={projectId} clips={selected} rerenderable={renderable.length} onDone={onChanged} className={btn} />
      </div>
    </div>
  );
}
