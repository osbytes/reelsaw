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
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

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
  const { t } = useLingui();
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
  const others = selected.length - failed.length;
  const retryBody = [
    failed.length === 1
      ? t`“${failed[0]?.title}” resumes from the last stage that didn’t finish; finished clips, transcripts and sources are kept.`
      : plural(failed.length, {
          one: "# failed project resumes from the last stage that didn’t finish; finished clips, transcripts and sources are kept.",
          other: "# failed projects resume from the last stage that didn’t finish; finished clips, transcripts and sources are kept.",
        }),
    others === 1
      ? t`The other selected project didn’t fail and is left as it is.`
      : others > 1
        ? t`The other ${others} projects didn’t fail and are left as they are.`
        : "",
    t`Processing counts toward your minutes as usual.`,
  ]
    .filter(Boolean)
    .join(" ");
  const rerenderBody = [
    withClips.length === 1
      ? t`Every finished or failed clip of “${withClips[0]?.title}” renders again with its current settings (style, intro and outro, template); each new video replaces the old one when done.`
      : t`Every finished or failed clip of ${withClips.length} projects renders again with its current settings (style, intro and outro, template); each new video replaces the old one when done.`,
    t`Clips still preparing or rendering are left alone.`,
    working ? plural(working, { one: "# project is still processing.", other: "# projects are still processing." }) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const keepHint = keepWindow.hint(selected.length > 1);
  const deleteBody = [
    one
      ? t`“${one.title}”: the project, its transcript and every clip are hidden.`
      : t`${selected.length} projects, with their transcripts and clips, are hidden.`,
    working ? t`Work in progress stops.` : "",
    keepHint,
    one ? t`Storage still counts until you delete it forever.` : t`Storage still counts until you delete them forever.`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <SelectionBar label={t`Selected projects`} count={selected.length} busy={busy} onClear={onClear}>
      <button
        type="button"
        className="btn-ghost"
        disabled={busy || !failed.length}
        title={
          failed.length
            ? plural(failed.length, { one: "Resume # failed project where each stopped", other: "Resume # failed projects where each stopped" })
            : t`None of the selected projects failed`
        }
        onClick={() => setAsk("retry")}
      >
        <span className="sm:hidden">
          <Trans>Retry…</Trans>
        </span>
        <span className="max-sm:hidden">
          <Trans>Retry failed…</Trans>
        </span>
      </button>
      <button
        type="button"
        className="btn-ghost"
        disabled={busy || !withClips.length}
        title={
          withClips.length
            ? plural(withClips.length, { one: "Re-render the clips of # project", other: "Re-render the clips of # projects" })
            : t`None of the selected projects has clips yet`
        }
        onClick={() => setAsk("rerender")}
      >
        <Trans>Re-render…</Trans>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <MoreButton aria-label={t`More actions for the selection`} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="end" sideOffset={8} className="menu w-[220px]">
            <DropdownMenu.Item className="menu-item" disabled={selected.length >= total} onSelect={onSelectAll}>
              {total > selected.length ? t`Select all (${total})` : t`Select all`}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
            <DropdownMenu.Item className="menu-item-danger" disabled={busy} onSelect={() => later(() => setAsk("delete"))}>
              <Trans>Delete…</Trans>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={ask === "retry"}
        onOpenChange={(o) => !o && setAsk(null)}
        title={failed.length === 1 ? t`Retry this failed project?` : t`Retry ${failed.length} failed projects?`}
        body={retryBody}
        confirm={failed.length === 1 ? t`Retry project` : t`Retry projects`}
        onConfirm={() =>
          retry.mutateAsync({ ids: ids(failed) }).then((r) => {
            onChanged();
            const why = firstError(r.results);
            const notRetried = r.failed;
            const skipped = r.skipped;
            toast(
              r.failed
                ? plural(r.retried, {
                    one: `Retrying # project · ${notRetried} couldn’t be retried${why}`,
                    other: `Retrying # projects · ${notRetried} couldn’t be retried${why}`,
                  })
                : r.skipped
                  ? plural(r.retried, { one: `Retrying # project · ${skipped} no longer failed`, other: `Retrying # projects · ${skipped} no longer failed` })
                  : plural(r.retried, { one: "Retrying # project", other: "Retrying # projects" }),
            );
          })
        }
      />
      <ConfirmDialog
        open={ask === "rerender"}
        onOpenChange={(o) => !o && setAsk(null)}
        title={withClips.length === 1 ? t`Re-render this project’s clips?` : t`Re-render the clips of ${withClips.length} projects?`}
        body={rerenderBody}
        confirm={t`Re-render clips`}
        onConfirm={() =>
          rerender.mutateAsync({ ids: ids(withClips) }).then((r) => {
            onChanged();
            const why = firstError(r.results);
            const clips = plural(r.rerendered, { one: "Re-rendering # clip", other: "Re-rendering # clips" });
            const notQueued = plural(r.failed, { one: `# project couldn’t be queued${why}`, other: `# projects couldn’t be queued${why}` });
            const skipped = r.skipped;
            toast(r.failed ? `${clips} · ${notQueued}` : r.skipped ? t`${clips} · ${skipped} still busy, left alone` : clips);
          })
        }
      />
      <ConfirmDialog
        open={ask === "delete"}
        onOpenChange={(o) => {
          if (!o) setAsk(null);
          setForget(false);
        }}
        title={one ? t`Delete this project?` : t`Delete ${selected.length} projects?`}
        body={deleteBody}
        confirm={one ? t`Delete project` : t`Delete projects`}
        danger
        onConfirm={() => {
          const ps = selected;
          return del.mutateAsync({ ids: ids(ps), forgetDecisions: forget }).then((r) => {
            onClear();
            onChanged();
            const why = firstError(r.results);
            if (r.failed) toast.error(t`${r.failed} couldn’t be deleted${why}`);
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
