/**
 * Settings → Billing (enterprise edition; see ../LICENSE). Loaded lazily and only when me.get says the instance
 * runs billing. Money moves on Stripe-hosted pages: the buttons open Checkout or the Billing Portal; after a
 * return the page refetches until the webhook-driven sync has written the new plan, then welcomes the account to it
 * (UpgradeWelcome.tsx). An upgrade offer's `?from=` project goes to checkout: only that project is finished and
 * re-rendered by itself; the others are picked in the welcome dialog or the "Your other projects" section.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { useTRPC } from "../../lib/trpc";
import { track } from "../../lib/telemetry";
import { CHECKOUT_PARAM, deletedProjectsPath, FROM_PROJECT_PARAM, INTERVAL_PARAM, isCheckoutOutcome, PLAN_PARAM, formatDay, formatMb } from "@reelsaw/shared";
import { Pending, Skeleton, SkeletonRegion } from "../../components/ui";
import { UpgradeWelcome, UpgradeWorkPicker } from "./UpgradeWelcome";

const num = new Intl.NumberFormat();

type Interval = "month" | "year";

/** The plan before a Stripe round trip, kept across it so the return can say what changed (this tab only). */
const BEFORE_KEY = "reelsaw.checkout.planBefore";
const storedBefore = (): string | null => {
  try {
    return sessionStorage.getItem(BEFORE_KEY);
  } catch {
    return null;
  }
};
const storeBefore = (plan: string | null) => {
  try {
    if (plan) sessionStorage.setItem(BEFORE_KEY, plan);
    else sessionStorage.removeItem(BEFORE_KEY);
  } catch {
    // private mode: the welcome then compares with the plan shown when the page loaded
  }
};

export default function BillingSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const loc = useLocation();
  const nav = useNavigate();
  const q = useQuery({ ...trpc.billing.get.queryOptions(), staleTime: 5_000 });
  const [interval, setInterval_] = useState<Interval | null>(null);
  // the grid starts on the interval the account pays for, once known
  const intervalShown: Interval = interval ?? (q.data?.subscription?.interval === "year" ? "year" : "month");
  // the project an upgrade offer was shown on (UpgradeNotice, the Download ask, a refusal): read once, sent with checkout
  const [fromProjectId] = useState(() => new URLSearchParams(loc.search).get(FROM_PROJECT_PARAM) || undefined);
  const checkout = useMutation({
    ...trpc.billing.checkout.mutationOptions(),
    onSuccess: ({ url, kind }, vars) => {
      track("checkout_started", { plan: vars.plan, interval: vars.interval ?? "month", kind, fromProject: !!vars.fromProjectId });
      storeBefore(q.data?.plan.name ?? null);
      window.location.assign(url);
    },
    onError: (e) => toast.error(e.message),
  });
  const portal = useMutation({
    ...trpc.billing.portal.mutationOptions(),
    onSuccess: ({ url }) => {
      track("billing_portal_opened");
      window.location.assign(url);
    },
    onError: (e) => toast.error(e.message),
  });

  // arriving with a plan picked on the website (/signup?plan=): go straight to Checkout once the state is known
  const wanted = new URLSearchParams(loc.search).get(PLAN_PARAM);
  const wantedInterval: Interval = new URLSearchParams(loc.search).get(INTERVAL_PARAM) === "year" ? "year" : "month";
  const started = useRef(false);
  useEffect(() => {
    if (!wanted || !q.data || started.current) return;
    started.current = true;
    nav({ pathname: loc.pathname, search: "" }, { replace: true });
    const p = q.data.plans.find((x) => x.name === wanted);
    if (!p?.price) return;
    if (q.data.plan.name === wanted) return void toast(`You are on ${p.label} already`);
    setInterval_(wantedInterval);
    toast(`Taking you to Stripe for ${p.label}…`);
    checkout.mutate({ plan: wanted, interval: wantedInterval, fromProjectId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, !!q.data]);

  // back from Stripe: say so once, then poll a few times until the sync has landed (the webhook races the redirect)
  const raw = new URLSearchParams(loc.search).get(CHECKOUT_PARAM);
  const outcome = isCheckoutOutcome(raw) ? raw : null;
  const polled = useRef(0);
  // the welcome opens once the new plan shows (the sync lands after the redirect, or before it)
  const [waitingFrom, setWaitingFrom] = useState<string | null>(null);
  const [welcome, setWelcome] = useState<{ before: string } | null>(null);
  useEffect(() => {
    if (!outcome) return;
    if (outcome === "success") toast("Thanks! Your plan updates as soon as Stripe confirms the payment");
    else if (outcome === "changed") toast("Plan change confirmed; it shows here in a moment");
    else if (outcome === "canceled") toast("Checkout canceled; nothing changed");
    const planBefore = storedBefore() ?? q.data?.plan.name;
    storeBefore(null);
    if (outcome !== "canceled" && planBefore) setWaitingFrom(planBefore);
    const t = window.setInterval(() => {
      polled.current += 1;
      void qc.invalidateQueries({ queryKey: trpc.billing.get.queryKey() });
      void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
      const now = qc.getQueryData(trpc.billing.get.queryKey())?.plan.name;
      if (polled.current >= 15 || (outcome !== "canceled" && now && now !== planBefore)) window.clearInterval(t);
    }, 2000);
    nav({ pathname: loc.pathname, search: "" }, { replace: true });
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const d = q.data;
  const planNow = d?.plan.name;
  const priceOf = (name: string | undefined) => d?.plans.find((p) => p.name === name)?.price?.month ?? 0;
  // a move to a dearer plan only: a downgrade has nothing to welcome
  const upgraded = !!waitingFrom && !!planNow && planNow !== waitingFrom && priceOf(planNow) > priceOf(waitingFrom);
  useEffect(() => {
    if (!waitingFrom || !planNow || planNow === waitingFrom) return;
    setWaitingFrom(null);
    if (!upgraded) return;
    setWelcome({ before: waitingFrom });
    track("upgrade_welcome_shown", { plan: planNow, before: waitingFrom });
  }, [waitingFrom, planNow, upgraded]);
  const welcomePlan = welcome && d ? d.plans.find((p) => p.name === d.plan.name) : undefined;
  /** the highest plan's queue priority: that plan's cards say "top of the queue" */
  const topPriority = Math.max(1, ...(d?.plans ?? []).map((x) => x.queuePriority));
  const sub = d?.subscription;
  const period = d?.period;
  const minutesCap = d?.limits.MAX_SOURCE_MINUTES_PER_MONTH ?? 0;
  const storageCap = d?.limits.MAX_STORAGE_MB ?? 0;
  const projectsCap = d?.limits.MAX_PROJECTS_PER_USER ?? 0;

  const statusLine = !d
    ? ""
    : d.reason === "complimentary"
      ? "Granted by an admin."
      : d.reason === "grace"
        ? `Payment failed; the plan stays until ${sub?.graceEndsAt ? formatDay(sub?.graceEndsAt) : ""}. Update your card to keep it.`
        : d.reason === "lapsed"
          ? "Payment failed and the grace period ended: the account is on Free until the card is updated."
          : d.reason === "trialing"
            ? `Trial until ${sub?.periodEnd ? formatDay(sub?.periodEnd) : ""}.`
            : sub?.cancelAt
              ? `Canceled: the plan stays until ${formatDay(sub.cancelAt)}, then the account moves to Free.`
              : sub?.periodEnd && d.reason === "active"
                ? `Renews on ${formatDay(sub.periodEnd)}${sub.interval ? ` (${sub.interval === "year" ? "yearly" : "monthly"})` : ""}.`
                : "No subscription: the Free plan. Pick a plan below to lift the limits.";

  const bar = (used: number, cap: number) => {
    const ratio = cap > 0 ? Math.min(1, used / cap) : 0;
    const tone = ratio >= 1 ? "bg-err" : ratio >= 0.8 ? "bg-warn" : "bg-acc";
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunk" aria-hidden>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
    );
  };

  return (
    <>
      {welcome && welcomePlan && d && (
        <UpgradeWelcome before={d.plans.find((p) => p.name === welcome.before)} after={welcomePlan} onClose={() => setWelcome(null)} />
      )}
      <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-bold">Plan</h2>
          <span className="min-h-4 font-mono text-xs text-ink3">{period ? `Period ${formatDay(period.start)} to ${formatDay(period.end)}` : ""}</span>
        </div>
        {q.isPending ? (
          <SkeletonRegion className="flex flex-col gap-3">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-3/4" />
            <div className="grid gap-4 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-1.5 w-full rounded-full" />
                  <Skeleton className="h-3 w-32" />
                </div>
              ))}
            </div>
          </SkeletonRegion>
        ) : q.error ? (
          <p className="text-sm text-err">✕ {q.error.message}</p>
        ) : d ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[22px] font-bold tracking-tight">{d.plan.label}</span>
              {d.plan.price && (
                <span className="font-mono text-sm text-ink2">{sub?.interval === "year" ? `$${d.plan.price.year}/yr` : `$${d.plan.price.month}/mo`}</span>
              )}
              <span className={`chip ${d.watermark.on ? "bg-warn-soft text-warn" : "bg-acc-soft text-acc-text"}`}>
                {d.watermark.on ? "◇ watermark on" : "◆ no watermark"}
              </span>
              {d.afterCancel && <span className="chip bg-warn-soft text-warn">◷ Cancels {formatDay(d.afterCancel.at, { month: "short", year: false })}</span>}
            </div>
            <p className="min-h-5 text-sm text-ink2">{statusLine}</p>
            {d.afterCancel && (
              <div className="flex flex-col gap-3 rounded-[12px] border border-warn/40 bg-warn-soft px-4 py-3.5 text-sm">
                <div className="flex flex-col gap-0.5">
                  <span className="font-semibold text-warn">
                    {d.plan.label} ends on {formatDay(d.afterCancel.at)}, then this account is on {d.afterCancel.planLabel}
                  </span>
                  <span className="text-ink2">Until then nothing changes. From that day:</span>
                </div>
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-3">
                  {(
                    [
                      ["MAX_SOURCE_MINUTES_PER_MONTH", "Minutes a month", (n: number) => num.format(n)],
                      ["MAX_STORAGE_MB", "Storage", formatMb],
                      ["MAX_PROJECTS_PER_USER", "Projects kept", (n: number) => num.format(n)],
                    ] as const
                  ).map(([key, label, fmt]) => {
                    const over = d.afterCancel!.over.find((o) => o.key === key);
                    const cap = (n: number) => (n > 0 ? fmt(n) : "no cap");
                    return (
                      <div key={key} className="flex flex-col gap-0.5">
                        <dt className="text-xs font-semibold text-ink2">{label}</dt>
                        <dd className={`tabular-nums ${over ? "font-semibold text-warn" : "text-ink"}`}>
                          {cap(d.limits[key])} → {cap(d.afterCancel!.limits[key])}
                          {over && " · over"}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                {d.afterCancel.over.length > 0 && (
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-ink">
                    {d.afterCancel.over.map((o) => (
                      <li key={o.key}>{o.sentence}</li>
                    ))}
                  </ul>
                )}
                <ul className="flex list-disc flex-col gap-1 pl-5 text-ink2">
                  {d.afterCancel.expect.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn-primary min-w-[9rem]" disabled={portal.isPending} onClick={() => portal.mutate()}>
                    <Pending busy={portal.isPending}>Keep {d.plan.label}</Pending>
                  </button>
                  <span className="text-xs text-ink3">Opens Stripe's portal: choose "Don't cancel subscription".</span>
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink2">Minutes this period</span>
                {bar(d.usage.MAX_SOURCE_MINUTES_PER_MONTH, minutesCap)}
                <span className="text-xs tabular-nums text-ink3">
                  {minutesCap
                    ? `${num.format(d.usage.MAX_SOURCE_MINUTES_PER_MONTH)} of ${num.format(minutesCap)} min`
                    : `${num.format(d.usage.MAX_SOURCE_MINUTES_PER_MONTH)} min, no cap`}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink2">Storage</span>
                {bar(d.usage.MAX_STORAGE_MB, storageCap)}
                <span className="text-xs tabular-nums text-ink3">
                  {storageCap ? `${formatMb(d.usage.MAX_STORAGE_MB)} of ${formatMb(storageCap)}` : `${formatMb(d.usage.MAX_STORAGE_MB)}, no cap`}
                </span>
                <span className="text-xs text-ink3">
                  Deleted projects still count until you{" "}
                  <Link to={deletedProjectsPath()} className="text-acc-text no-underline hover:underline">
                    delete them forever
                  </Link>
                  .
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink2">Projects</span>
                {bar(d.usage.MAX_PROJECTS_PER_USER, projectsCap)}
                <span className="text-xs tabular-nums text-ink3">
                  {projectsCap
                    ? `${num.format(d.usage.MAX_PROJECTS_PER_USER)} of ${num.format(projectsCap)}`
                    : `${num.format(d.usage.MAX_PROJECTS_PER_USER)}, no cap`}
                </span>
              </div>
            </div>
            <div className="flex min-h-9 flex-wrap items-center gap-2">
              <button
                className="btn-ghost min-w-[9rem]"
                disabled={!d.canManage || portal.isPending}
                title={d.canManage ? "Invoices, card, cancel" : "Appears once you have picked a plan"}
                onClick={() => portal.mutate()}
              >
                {portal.isPending ? "…" : "Manage billing"}
              </button>
              <span className="text-xs text-ink3">Invoices, payment method and cancellation are on Stripe's portal.</span>
            </div>
          </>
        ) : null}
      </section>

      {d && d.plan.name !== "free" && !welcome && <OtherProjects />}

      <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-bold">Plans</h2>
          <div className="flex rounded-[9px] bg-sunk p-0.5" role="group" aria-label="Billing interval">
            {(["month", "year"] as const).map((i) => (
              <button
                key={i}
                type="button"
                className={`h-7 min-w-[5.5rem] rounded-[7px] px-3 text-xs font-semibold ${intervalShown === i ? "bg-panel text-ink shadow-sm" : "text-ink2"}`}
                aria-pressed={intervalShown === i}
                onClick={() => setInterval_(i)}
              >
                {i === "month" ? "Monthly" : "Yearly"}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(d?.plans ?? [null, null, null, null]).map((p, i) =>
            !p ? (
              <div key={i} className="flex flex-col gap-2 rounded-[12px] border border-line p-4" aria-hidden>
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="mt-2 h-9 w-full rounded-[9px]" />
              </div>
            ) : (
              <div key={p.name} className={`flex flex-col gap-2 rounded-[12px] border p-4 ${d?.plan.name === p.name ? "border-acc" : "border-line"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold">{p.label}</span>
                  {d?.plan.name === p.name && <span className="chip bg-acc-soft text-acc-text">current</span>}
                </div>
                <div className="font-mono text-[22px] font-bold tracking-tight">
                  {p.price ? (intervalShown === "year" ? `$${p.price.year}` : `$${p.price.month}`) : "$0"}
                  <span className="text-xs font-normal text-ink3">{p.price ? (intervalShown === "year" ? " / year" : " / month") : ""}</span>
                </div>
                <p className="min-h-10 text-xs text-ink2">{p.blurb}</p>
                <ul className="flex flex-col gap-1 text-xs text-ink2">
                  {p.firstVideoFreeMinutes > 0 && <li>First video free up to {p.firstVideoFreeMinutes} minutes</li>}
                  <li>
                    {p.limits.MAX_SOURCE_MINUTES_PER_MONTH
                      ? `${num.format(p.limits.MAX_SOURCE_MINUTES_PER_MONTH)} minutes of video a month`
                      : "Unlimited minutes"}
                  </li>
                  <li>{p.limits.MAX_STORAGE_MB ? `${formatMb(p.limits.MAX_STORAGE_MB)} of storage` : "Unlimited storage"}</li>
                  <li>{p.limits.MAX_PROJECTS_PER_USER ? `${num.format(p.limits.MAX_PROJECTS_PER_USER)} projects` : "Unlimited projects"}</li>
                  <li>{p.watermark ? "Small watermark" : "No watermark"}</li>
                  {p.queuePriority > 0 && <li>{p.queuePriority >= topPriority ? "Top of the processing queue" : "Jobs start ahead of lower plans"}</li>}
                </ul>
                <div className="mt-auto pt-2">
                  {p.price ? (
                    <button
                      className={`${d?.plan.name === p.name ? "btn-ghost" : "btn-ink"} h-9 w-full`}
                      disabled={checkout.isPending || !d || (d.plan.name === p.name && (d.subscription?.interval ?? "month") === intervalShown)}
                      onClick={() => checkout.mutate({ plan: p.name, interval: intervalShown, fromProjectId })}
                    >
                      {checkout.isPending && checkout.variables?.plan === p.name
                        ? "…"
                        : d?.plan.name === p.name
                          ? (d.subscription?.interval ?? "month") === intervalShown
                            ? "Current plan"
                            : `Switch to ${intervalShown === "year" ? "yearly" : "monthly"}`
                          : d?.plan.price && d.plan.price.month > p.price.month
                            ? "Downgrade"
                            : "Upgrade"}
                    </button>
                  ) : (
                    <button
                      className="btn-ghost h-9 w-full"
                      disabled
                      title={d?.plan.name === "free" ? "You are on Free" : "Cancel from Manage billing; Free applies when the period ends"}
                    >
                      {d?.plan.name === "free" ? "Current plan" : "Cancel to return here"}
                    </button>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
        <p className="text-xs text-ink3">
          Prices in USD; tax is added at checkout where it applies. Yearly is ten months for twelve. Changing plans is prorated by Stripe.
        </p>
      </section>
    </>
  );
}

/** The projects a past plan change could still improve (the welcome dialog's list), while there are any. */
function OtherProjects() {
  const trpc = useTRPC();
  const q = useQuery(trpc.projects.upgradeWork.queryOptions());
  const w = q.data;
  if (!w || (!w.rerender.projects.length && !w.finish.projects.length)) return null;
  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">Your other projects</h2>
      <UpgradeWorkPicker placement="billing" />
    </section>
  );
}
