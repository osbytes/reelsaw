import { Link } from "react-router";
import { upgradeFromProject, type QuotaAction, type QuotaRefusal } from "@reelsaw/shared";
import { openReport } from "../lib/report";
import { track } from "../lib/telemetry";
import { t } from "@lingui/core/macro";

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

function Action({
  action,
  quota,
  placement,
  projectId,
}: {
  action: QuotaAction;
  quota: QuotaRefusal;
  placement: QuotaPlacement;
  projectId?: string | undefined;
}) {
  const cls = action.kind === "upgrade" || action.kind === "request" ? "btn-primary py-1.5 text-xs no-underline" : "btn-ghost py-1.5 text-xs no-underline";
  // the server's `quota.refused` / `quota.warned` count who met the limit; this counts who acted on it (upgrade, request, free space)
  const clicked = () => track("quota_action_clicked", { key: quota.key, action: action.kind, placement });
  if (action.kind === "request") {
    const limitName = quota.key.replaceAll("_", " ").toLowerCase();
    return (
      <button
        type="button"
        className={cls}
        onClick={() => {
          clicked();
          openReport({
            prefill: t`I'd like more capacity on my current plan (${limitName}).`,
            tags: { source: "quota-capacity", limit: quota.key },
          });
        }}
      >
        {action.label}
      </button>
    );
  }
  // an upgrade from a project's own refusal is that project's upgrade: it is finished by itself after the plan change
  const href = action.kind === "upgrade" && projectId ? upgradeFromProject(action.href, projectId) : action.href;
  if (href.startsWith("http")) {
    return (
      <a href={href} className={cls} onClick={clicked}>
        {action.label}
      </a>
    );
  }
  return (
    <Link to={href} className={cls} onClick={clicked}>
      {action.label}
    </Link>
  );
}

/**
 * Sentence plus the upgrade / request / free-space actions the server attached to a quota refusal. A `precheck` notice
 * is a heads-up before anything was submitted, so it reads as a warning, not an error. `projectId`: the refusal is about
 * that project, so its upgrade link carries it (`upgradeFromProject`).
 */
export function QuotaNotice({
  message,
  quota,
  className,
  placement = "refusal",
  projectId,
}: {
  message: string;
  quota?: QuotaRefusal | null | undefined;
  className?: string;
  placement?: QuotaPlacement;
  projectId?: string | undefined;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className ?? ""}`}>
      <p className={`text-[13px] leading-snug ${placement === "precheck" ? "text-warn" : "text-err"}`}>{quota?.sentence ?? message}</p>
      {(quota?.primary || quota?.secondary) && (
        <div className="flex flex-wrap items-center gap-2">
          {quota.primary && <Action action={quota.primary} quota={quota} placement={placement} projectId={projectId} />}
          {quota.secondary && <Action action={quota.secondary} quota={quota} placement={placement} projectId={projectId} />}
        </div>
      )}
    </div>
  );
}
