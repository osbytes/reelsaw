import { Link } from "react-router";
import type { QuotaAction, QuotaRefusal } from "@reelsaw/shared";
import { openReport } from "../lib/report";
import { track } from "../lib/telemetry";

export function quotaFromError(err: unknown): QuotaRefusal | undefined {
  if (!err || typeof err !== "object") return;
  const o = err as { data?: { quota?: QuotaRefusal }; quota?: QuotaRefusal };
  if (isRefusal(o.quota)) return o.quota;
  if (isRefusal(o.data?.quota)) return o.data.quota;
  return;
}

function isRefusal(v: unknown): v is QuotaRefusal {
  return !!v && typeof v === "object" && "key" in (v as object);
}

/** Where the notice was shown: a refusal the server sent back, or a warning before the user submitted (New Project). */
export type QuotaPlacement = "refusal" | "precheck";

function Action({ action, quota, placement }: { action: QuotaAction; quota: QuotaRefusal; placement: QuotaPlacement }) {
  const cls = action.kind === "upgrade" || action.kind === "request" ? "btn-primary py-1.5 text-xs no-underline" : "btn-ghost py-1.5 text-xs no-underline";
  // the server's `quota.refused` / `quota.warned` count who met the limit; this counts who acted on it (upgrade, request, free space)
  const clicked = () => track("quota_action_clicked", { key: quota.key, action: action.kind, placement });
  if (action.kind === "request") {
    return (
      <button
        type="button"
        className={cls}
        onClick={() => {
          clicked();
          openReport({
            prefill: `I'd like more capacity on my current plan (${quota.key.replaceAll("_", " ").toLowerCase()}).`,
            tags: { source: "quota-capacity", limit: quota.key },
          });
        }}
      >
        {action.label}
      </button>
    );
  }
  if (action.href.startsWith("http")) {
    return (
      <a href={action.href} className={cls} onClick={clicked}>
        {action.label}
      </a>
    );
  }
  return (
    <Link to={action.href} className={cls} onClick={clicked}>
      {action.label}
    </Link>
  );
}

/**
 * Sentence plus the upgrade / request / free-space actions the server attached to a quota refusal. A `precheck` notice
 * is a heads-up before anything was submitted, so it reads as a warning, not an error.
 */
export function QuotaNotice({
  message,
  quota,
  className,
  placement = "refusal",
}: {
  message: string;
  quota?: QuotaRefusal | null | undefined;
  className?: string;
  placement?: QuotaPlacement;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className ?? ""}`}>
      <p className={`text-[13px] leading-snug ${placement === "precheck" ? "text-warn" : "text-err"}`}>{message}</p>
      {(quota?.primary || quota?.secondary) && (
        <div className="flex flex-wrap items-center gap-2">
          {quota.primary && <Action action={quota.primary} quota={quota} placement={placement} />}
          {quota.secondary && <Action action={quota.secondary} quota={quota} placement={placement} />}
        </div>
      )}
    </div>
  );
}
