/**
 * After a plan change (enterprise edition; see ../LICENSE). `UpgradeWelcome` is the dialog Billing opens once Stripe
 * confirmed the new plan: what the plan gives next to what the old one did, then the account's other projects it
 * could improve. `UpgradeWorkPicker` is that list on its own (the dialog and the Billing page): nothing is ticked, the
 * project the upgrade started from is already being handled by the server, and Start sends the picked ones to
 * projects.startUpgradeWork (the same service as MCP start_upgrade_work), so the new minutes and the hour's re-renders
 * go only where the owner chose.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatMb, formatNumber, projectPath } from "@reelsaw/shared";
import { plural, t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC } from "../../lib/trpc";
import { track } from "../../lib/telemetry";
import { Modal, Pending, Skeleton, SkeletonRegion } from "../../components/ui";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type Plan = RouterOutputs["billing"]["get"]["plans"][number];

const num = { format: (n: number) => formatNumber(n) };
const m = (sec: number) => Math.round(sec / 60);

/** What the new plan gives that the old one did not, one line each, old value → new value. */
function gains(before: Plan | undefined, after: Plan): Array<{ label: string; from: string | null; to: string }> {
  const cap = (n: number, fmt: (n: number) => string) => (n > 0 ? fmt(n) : t`Unlimited`);
  // 0 = no cap: more than any number
  const more = (a: number, b: number) => (b === 0 ? a !== 0 : a !== 0 && b > a);
  const out: Array<{ label: string; from: string | null; to: string }> = [];
  const lim = (key: keyof Plan["limits"], label: string, fmt: (n: number) => string) => {
    // an absent limit is no cap, like 0 (the plan cards read them the same way)
    const a = before ? (before.limits[key] ?? 0) : undefined;
    const b = after.limits[key] ?? 0;
    if (a === undefined || more(a, b)) out.push({ label, from: a === undefined ? null : cap(a, fmt), to: cap(b, fmt) });
  };
  lim("MAX_SOURCE_MINUTES_PER_MONTH", t`Minutes of video a month`, (n) => t`${num.format(n)} min`);
  lim("MAX_STORAGE_MB", t`Storage`, formatMb);
  lim("MAX_PROJECTS_PER_USER", t`Projects kept`, (n) => num.format(n));
  if (!after.watermark && (!before || before.watermark)) out.push({ label: t`Watermark`, from: before ? t`On every clip` : null, to: t`None` });
  if (after.queuePriority > (before?.queuePriority ?? 0))
    out.push({ label: t`Processing queue`, from: before ? t`Standard` : null, to: t`Ahead of lower plans` });
  return out;
}

export function UpgradeWelcome({ before, after, onClose }: { before: Plan | undefined; after: Plan; onClose: () => void }) {
  const { t } = useLingui();
  const list = gains(before, after);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t`Welcome to ${after.label}`} width={520}>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <p className="text-[13px] leading-snug text-ink2">{after.blurb || t`Your new plan is active.`}</p>
        {list.length > 0 && (
          <dl className="flex flex-col gap-1.5 rounded-[12px] bg-acc-soft px-4 py-3 text-[13px]">
            {list.map((g) => (
              <div key={g.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <dt className="text-ink2">{g.label}</dt>
                <dd className="tabular-nums">
                  {g.from && <span className="text-ink3 line-through decoration-ink3/60">{g.from}</span>}
                  {g.from && <span className="px-1.5 text-ink3">→</span>}
                  <span className="font-semibold text-acc-text">{g.to}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <UpgradeWorkPicker placement="welcome" onStarted={onClose} empty={t`Nothing else to update: new videos get the new plan from the start.`} />
      </div>
      <div className="flex justify-end">
        <button type="button" className="btn-ghost py-1.5 text-xs" onClick={onClose}>
          <Trans>Done</Trans>
        </button>
      </div>
    </Modal>
  );
}

type Work = RouterOutputs["projects"]["upgradeWork"];

/**
 * The account's other projects a plan change could improve, unticked: watermarked clips to render again, videos only
 * partly clipped. Shows the minutes the ticked videos need against what the plan covers now.
 */
export function UpgradeWorkPicker({ placement, onStarted, empty }: { placement: "welcome" | "billing"; onStarted?: () => void; empty?: string }) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery(trpc.projects.upgradeWork.queryOptions());
  const [rerender, setRerender] = useState<ReadonlySet<string>>(new Set());
  const [finish, setFinish] = useState<ReadonlySet<string>>(new Set());
  const start = useMutation(
    trpc.projects.startUpgradeWork.mutationOptions({
      onSuccess: (r) => {
        track("upgrade_work_started", { placement, rerenderedClips: r.rerenderedClips, extendedProjects: r.extendedProjects, failed: r.failed });
        const firstError = r.results.find((x) => !x.ok);
        if (r.sentence) toast(`${r.sentence[0]!.toUpperCase()}${r.sentence.slice(1)}`);
        if (firstError && "error" in firstError) {
          const why = firstError.error;
          toast.error(r.failed > 1 ? plural(r.failed, { one: `# project did not start: ${why}`, other: `# projects did not start: ${why}` }) : why);
        }
        setRerender(new Set());
        setFinish(new Set());
        void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
        onStarted?.();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (q.isPending)
    return (
      <SkeletonRegion className="flex flex-col gap-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </SkeletonRegion>
    );
  if (q.error) return <p className="text-sm text-err">✕ {q.error.message}</p>;
  const w: Work = q.data;
  const nothing = !w.rerender.projects.length && !w.finish.projects.length;
  if (nothing && !w.upgradeProject) return empty ? <p className="text-[13px] text-ink3">{empty}</p> : null;

  const toggle = (set: ReadonlySet<string>, put: (s: ReadonlySet<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    put(n);
  };
  const needSec = w.finish.projects.filter((p) => finish.has(p.id)).reduce((s, p) => s + p.remainingSec, 0);
  const over = w.minutesRoomSec !== null && needSec > w.minutesRoomSec;
  const picked = new Set([...rerender, ...finish]).size;
  const row = "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-[9px] px-2 py-1.5 hover:bg-sunk";

  return (
    <div className="flex flex-col gap-3">
      {w.upgradeProject && (
        <p className="text-[13px] leading-snug text-ink">
          <span className="text-acc-text">✓</span>{" "}
          <Link to={projectPath(w.upgradeProject.id)} className="font-semibold text-ink no-underline hover:underline">
            {w.upgradeProject.title}
          </Link>{" "}
          <span className="text-ink2">
            <Trans>is being finished and rendered without the watermark now.</Trans>
          </span>
        </p>
      )}
      {!nothing && (
        <div className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">
            <Trans>Your other projects</Trans>
          </h3>
          <p className="text-xs text-ink3">
            <Trans>Pick what to update. Re-renders do not use minutes; clipping more of a video does.</Trans>
          </p>
        </div>
      )}
      {w.rerender.projects.length > 0 && (
        <fieldset className="flex flex-col">
          <legend className="pb-1 text-xs font-semibold text-ink2">
            <Trans>Render again without the watermark</Trans>
          </legend>
          {w.rerender.projects.map((p) => (
            <label key={p.id} className={row}>
              <input type="checkbox" className="accent-[var(--acc)]" checked={rerender.has(p.id)} onChange={() => toggle(rerender, setRerender, p.id)} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{p.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-ink3">
                <Plural value={p.clips} one="# clip" other="# clips" />
              </span>
            </label>
          ))}
          {w.rerender.total > w.rerender.projects.length && (
            <p className="px-2 pt-1 text-xs text-ink3">
              <Plural
                value={w.rerender.total - w.rerender.projects.length}
                one="and # older project; re-render them from their own page."
                other="and # older projects; re-render them from their own page."
              />
            </p>
          )}
        </fieldset>
      )}
      {w.finish.projects.length > 0 && (
        <fieldset className="flex flex-col">
          <legend className="pb-1 text-xs font-semibold text-ink2">
            <Trans>Clip the rest of the video</Trans>
          </legend>
          {w.finish.projects.map((p) => (
            <label key={p.id} className={`${row} ${p.busy ? "cursor-default opacity-60" : ""}`}>
              <input
                type="checkbox"
                className="accent-[var(--acc)]"
                disabled={p.busy}
                checked={finish.has(p.id)}
                onChange={() => toggle(finish, setFinish, p.id)}
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">{p.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-ink3">{p.busy ? t`working` : t`${m(p.remainingSec)} of ${m(p.durationSec)} min left`}</span>
            </label>
          ))}
          {w.finish.total > w.finish.projects.length && (
            <p className="px-2 pt-1 text-xs text-ink3">
              <Plural
                value={w.finish.total - w.finish.projects.length}
                one="and # older video; clip the rest from their own page."
                other="and # older videos; clip the rest from their own page."
              />
            </p>
          )}
        </fieldset>
      )}
      {!nothing && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`min-h-4 text-xs tabular-nums ${over ? "text-warn" : "text-ink3"}`}>
            {finish.size === 0
              ? ""
              : w.minutesRoomSec === null
                ? t`${m(needSec)} min of video`
                : over
                  ? t`${m(needSec)} min picked, ${m(w.minutesRoomSec)} min left: the first ones get as much as fits`
                  : t`${m(needSec)} of ${m(w.minutesRoomSec)} min left`}
          </span>
          <button
            type="button"
            className="btn-primary min-w-[7rem] py-1.5 text-xs"
            disabled={!picked || start.isPending}
            aria-busy={start.isPending}
            onClick={() => start.mutate({ rerender: rerender.size ? [...rerender] : undefined, finish: finish.size ? [...finish] : undefined })}
          >
            <Pending busy={start.isPending}>{picked ? plural(picked, { one: "Update # project", other: "Update # projects" }) : t`Pick projects`}</Pending>
          </button>
        </div>
      )}
    </div>
  );
}
