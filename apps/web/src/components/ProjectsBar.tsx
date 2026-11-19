import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { ForgetDecisionsOption } from "./ForgetDecisionsOption";
import { SelectionBar } from "./SelectionBar";
import { ConfirmDialog, MoreButton } from "./ui";
import { plural } from "@reelsaw/shared";

interface BarProject {
  id: string;
  title: string;
  status: string;
  clipCount: number;
  clipsDone: number;
}

const ACTIVE = new Set(["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]);
/** The first per-project reason of a partly failed bulk call, so the toast says why. */
const firstError = (results: Array<{ ok: boolean; error?: string }>) => {
  const e = results.find((x) => !x.ok && x.error)?.error;
  return e ? `: ${e.slice(0, 160)}` : "";
};

type Ask = "delete" | "retry" | "rerender" | null;

/**
 * The Projects page selection: Retry failed and Re-render on the row, Delete in ⋯. Every action asks first (what it
 * acts on, what is skipped) and the dialog keeps its spinner until the server is done; the bar shows `busy` too.
 * Same service code as `delete_projects` / `retry_projects` / `rerender_projects` and the CLI.
 */
export function ProjectsBar({
  selected,
  total,
  onSelectAll,
  onClear,
  onChanged,
}: {
  selected: BarProject[];
  /** loaded projects: "Select all" shows while fewer are selected */
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  onChanged: () => void;
}) {
  const trpc = useTRPC();
  const del = useMutation(trpc.projects.deleteMany.mutationOptions());
  const retry = useMutation(trpc.projects.retryMany.mutationOptions());
  const rerender = useMutation(trpc.projects.rerenderMany.mutationOptions());
  const notifyDeleted = useDeletedToast();
  const [ask, setAsk] = useState<Ask>(null);
  const [forget, setForget] = useState(false);
  const keepWindow = useRestoreWindow("project", ask === "delete");
  const busy = del.isPending || retry.isPending || rerender.isPending;

  const failed = selected.filter((p) => p.status === "failed");
  const withClips = selected.filter((p) => p.clipsDone > 0 || (p.status === "failed" && p.clipCount > 0));
  const working = selected.filter((p) => ACTIVE.has(p.status)).length;
  const ids = (ps: BarProject[]) => ps.map((p) => p.id);
  const later = (fn: () => void) => window.setTimeout(fn, 0);
  const one = selected.length === 1 ? selected[0] : undefined;

  return (
    <SelectionBar label="Selected projects" count={selected.length} busy={busy} onClear={onClear}>
      <button
        type="button"
        className="btn-ghost"
        disabled={busy || !failed.length}
        title={failed.length ? `Resume ${plural(failed.length, "failed project")} where each stopped` : "None of the selected projects failed"}
        onClick={() => setAsk("retry")}
      >
        <span className="sm:hidden">Retry…</span>
        <span className="max-sm:hidden">Retry failed…</span>
      </button>
      <button
        type="button"
        className="btn-ghost"
        disabled={busy || !withClips.length}
        title={withClips.length ? `Re-render the clips of ${plural(withClips.length, "project")}` : "None of the selected projects has clips yet"}
        onClick={() => setAsk("rerender")}
      >
        Re-render…
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <MoreButton aria-label="More actions for the selection" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="end" sideOffset={8} className="menu w-[220px]">
            <DropdownMenu.Item className="menu-item" disabled={selected.length >= total} onSelect={onSelectAll}>
              Select all {total > selected.length ? `(${total})` : ""}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
            <DropdownMenu.Item className="menu-item-danger" disabled={busy} onSelect={() => later(() => setAsk("delete"))}>
              Delete…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={ask === "retry"}
        onOpenChange={(o) => !o && setAsk(null)}
        title={failed.length === 1 ? "Retry this failed project?" : `Retry ${failed.length} failed projects?`}
        body={`${failed.length === 1 ? `“${failed[0]?.title}” resumes` : `${plural(failed.length, "failed project")} resume`} from the last stage that didn’t finish; finished clips, transcripts and sources are kept.${selected.length - failed.length === 1 ? " The other selected project didn’t fail and is left as it is." : selected.length > failed.length ? ` The other ${plural(selected.length - failed.length, "project")} didn’t fail and are left as they are.` : ""} Processing counts toward your minutes as usual.`}
        confirm={failed.length === 1 ? "Retry project" : "Retry projects"}
        onConfirm={() =>
          retry.mutateAsync({ ids: ids(failed) }).then((r) => {
            onChanged();
            toast(
              r.failed
                ? `Retrying ${plural(r.retried, "project")} · ${r.failed} couldn’t be retried${firstError(r.results)}`
                : `Retrying ${plural(r.retried, "project")}${r.skipped ? ` · ${r.skipped} no longer failed` : ""}`,
            );
          })
        }
      />
      <ConfirmDialog
        open={ask === "rerender"}
        onOpenChange={(o) => !o && setAsk(null)}
        title={withClips.length === 1 ? "Re-render this project’s clips?" : `Re-render the clips of ${withClips.length} projects?`}
        body={`Every finished or failed clip of ${withClips.length === 1 ? `“${withClips[0]?.title}”` : plural(withClips.length, "project")} renders again with its current settings (style, intro and outro, template); each new video replaces the old one when done. Clips still preparing or rendering are left alone.${working ? ` ${plural(working, "project")} ${working === 1 ? "is" : "are"} still processing.` : ""}`}
        confirm="Re-render clips"
        onConfirm={() =>
          rerender.mutateAsync({ ids: ids(withClips) }).then((r) => {
            onChanged();
            toast(
              r.failed
                ? `Re-rendering ${plural(r.rerendered, "clip")} · ${plural(r.failed, "project")} couldn’t be queued${firstError(r.results)}`
                : `Re-rendering ${plural(r.rerendered, "clip")}${r.skipped ? ` · ${r.skipped} still busy, left alone` : ""}`,
            );
          })
        }
      />
      <ConfirmDialog
        open={ask === "delete"}
        onOpenChange={(o) => {
          if (!o) setAsk(null);
          setForget(false);
        }}
        title={one ? "Delete this project?" : `Delete ${selected.length} projects?`}
        body={`${one ? `“${one.title}”: the project, its transcript and every clip are` : `${plural(selected.length, "project")}, with their transcripts and clips, are`} hidden.${working ? " Work in progress stops." : ""} ${keepWindow.hint(selected.length > 1)} Storage still counts until you delete ${one ? "it" : "them"} forever.`}
        confirm={one ? "Delete project" : "Delete projects"}
        danger
        onConfirm={() => {
          const ps = selected;
          return del.mutateAsync({ ids: ids(ps), forgetDecisions: forget }).then((r) => {
            onClear();
            onChanged();
            if (r.failed) toast.error(`${r.failed} couldn’t be deleted${firstError(r.results)}`);
            const gone = new Set(r.results.filter((x) => x.ok && "changed" in x && x.changed).map((x) => x.id));
            if (!gone.size) return;
            notifyDeleted({
              items: ps.filter((p) => gone.has(p.id)).map((p) => ({ kind: "project" as const, id: p.id, title: p.title })),
              restorable: r.restorable,
              storedBytes: r.storedBytes,
            });
          });
        }}
      >
        <ForgetDecisionsOption checked={forget} onChange={setForget} later />
      </ConfirmDialog>
    </SelectionBar>
  );
}
