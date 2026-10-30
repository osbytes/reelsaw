import { Link } from "react-router";
import type { QuotaAction, QuotaRefusal } from "@reelsaw/shared";
import { openReport } from "../lib/report";

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

function Action({ action, quota }: { action: QuotaAction; quota: QuotaRefusal }) {
  const cls = action.kind === "upgrade" || action.kind === "request" ? "btn-primary py-1.5 text-xs no-underline" : "btn-ghost py-1.5 text-xs no-underline";
  if (action.kind === "request") {
    return (
      <button
        type="button"
        className={cls}
        onClick={() =>
          openReport({
            prefill: `I'd like more capacity on my current plan (${quota.key.replaceAll("_", " ").toLowerCase()}).`,
            tags: { source: "quota-capacity", limit: quota.key },
          })
        }
      >
        {action.label}
      </button>
    );
  }
  if (action.href.startsWith("http")) {
    return (
      <a href={action.href} className={cls}>
        {action.label}
      </a>
    );
  }
  return (
    <Link to={action.href} className={cls}>
      {action.label}
    </Link>
  );
}

/** Sentence plus the upgrade / request / free-space actions the server attached to a quota refusal. */
export function QuotaNotice({ message, quota, className }: { message: string; quota?: QuotaRefusal | undefined; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className ?? ""}`}>
      <p className="text-[13px] leading-snug text-err">{message}</p>
      {(quota?.primary || quota?.secondary) && (
        <div className="flex flex-wrap items-center gap-2">
          {quota.primary && <Action action={quota.primary} quota={quota} />}
          {quota.secondary && <Action action={quota.secondary} quota={quota} />}
        </div>
      )}
    </div>
  );
}
