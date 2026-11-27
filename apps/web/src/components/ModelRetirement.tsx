/**
 * Models the providers are retiring (server: ai/retirement.ts). Admins see it in four places from one query: a chip in
 * the top bar (HeaderAlerts), a dot on Settings → System and on its Models section, a line under each model picker,
 * and a label on the picker's rows. The server re-reads the providers' listings every few hours, so this asks slowly.
 */
import { useQuery } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { plural } from "@lingui/core/macro";
import { formatDay } from "@reelsaw/shared";
import { isAfter } from "date-fns";
import { useTRPC } from "../lib/trpc";
import { useMe } from "../lib/account";

export function useModelLifecycle() {
  const trpc = useTRPC();
  const isAdmin = useMe().data?.role === "admin";
  return useQuery({ ...trpc.admin.models.lifecycle.queryOptions({ refresh: false }), enabled: isAdmin, staleTime: 30 * 60_000, refetchInterval: 60 * 60_000 });
}

type Status = "retired" | "soon" | "scheduled" | "deprecated";
/** retired and soon are urgent (red); a date further out or none yet is a warning */
export const urgent = (s: Status | null | undefined) => s === "retired" || s === "soon";

/** A dot beside a nav item while a model in use is retiring (red when urgent). */
export function ModelRetirementDot({ className = "" }: { className?: string }) {
  const { t } = useLingui();
  const d = useModelLifecycle().data;
  if (!d?.retiring) return null;
  const count = d.retiring;
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${urgent(d.worst) ? "bg-err" : "bg-warn"} ${className}`}
      role="img"
      aria-label={plural(count, { one: "# model in use is being retired", other: "# models in use are being retired" })}
      title={t`A model in use is being retired by its provider`}
    />
  );
}

/** "Retires January 14, 2027", "Retired …", "Deprecated": for a picker row, from the listing's date alone. */
export function useRetirementLabel() {
  const { t } = useLingui();
  return (r: { retiresAt: string | null } | undefined, now = Date.now()) => {
    if (!r) return null;
    if (!r.retiresAt) return t`deprecated, no date yet`;
    // providers give a UTC day: the same day for every reader
    const date = formatDay(r.retiresAt, { utc: true });
    return isAfter(r.retiresAt, now) ? t`retires ${date}` : t`retired ${date}`;
  };
}

/** Under a model picker: what the provider says about the model in use there, glyph plus words. Nothing when it says nothing. */
export function ModelRetirementLine({ model }: { model: string }) {
  const { t } = useLingui();
  const d = useModelLifecycle().data;
  const m = d?.models.find((x) => x.model === model);
  const r = m?.retirement;
  if (!r) return null;
  const date = r.retiresAt ? formatDay(r.retiresAt, { utc: true }) : "";
  const days = r.daysLeft ?? 0;
  const provider = m.providerTitle;
  const replacement = r.replacement;
  const text =
    r.status === "retired"
      ? t`${provider} retired this model on ${date}; calls may already fail. Pick another and Save.`
      : r.status === "deprecated"
        ? t`${provider} has deprecated this model and not set a date yet. Plan to switch.`
        : plural(days, {
            one: `${provider} retires this model on ${date}, in # day. Pick another and Save.`,
            other: `${provider} retires this model on ${date}, in # days. Pick another and Save.`,
          });
  return (
    <p className={`flex gap-1.5 text-[11px] leading-4 ${urgent(r.status) ? "text-err" : "text-warn"}`} role="status">
      <span aria-hidden className="font-mono">
        !
      </span>
      <span>
        {text}
        {replacement ? ` ${t`Suggested: ${replacement}`}` : ""}
      </span>
    </p>
  );
}
