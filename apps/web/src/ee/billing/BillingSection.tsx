/**
 * Settings → Billing (enterprise edition; see ../LICENSE). Loaded lazily and only when me.get says the instance
 * runs billing. Money moves on Stripe-hosted pages: the buttons open Checkout or the Billing Portal; after a
 * return the page refetches until the webhook-driven sync has written the new plan.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { useTRPC } from "../../lib/trpc";
import { track } from "../../lib/telemetry";
import { Skeleton, SkeletonRegion } from "../../components/ui";

const num = new Intl.NumberFormat();
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "");
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);

type Interval = "month" | "year";

export default function BillingSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const loc = useLocation();
  const nav = useNavigate();
  const q = useQuery({ ...trpc.billing.get.queryOptions(), staleTime: 5_000 });
  const [interval, setInterval_] = useState<Interval | null>(null);
  // the grid starts on the interval the account pays for, once known
  const intervalShown: Interval = interval ?? (q.data?.subscription?.interval === "year" ? "year" : "month");
  const checkout = useMutation({
    ...trpc.billing.checkout.mutationOptions(),
    onSuccess: ({ url, kind }, vars) => {
      track("checkout_started", { plan: vars.plan, interval: vars.interval ?? "month", kind });
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
  const wanted = new URLSearchParams(loc.search).get("plan");
  const wantedInterval: Interval = new URLSearchParams(loc.search).get("interval") === "year" ? "year" : "month";
  const started = useRef(false);
  useEffect(() => {
    if (!wanted || !q.data || started.current) return;
    started.current = true;
    nav({ pathname: loc.pathname, search: "" }, { replace: true });
    const p = q.data.plans.find((x) => x.name === wanted);
    if (!p || !p.price) return;
    if (q.data.plan.name === wanted) return void toast(`You are on ${p.label} already.`);
    setInterval_(wantedInterval);
    toast(`Taking you to Stripe for ${p.label}…`);
    checkout.mutate({ plan: wanted, interval: wantedInterval });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, !!q.data]);

  // back from Stripe: say so once, then poll a few times until the sync has landed (the webhook races the redirect)
  const outcome = new URLSearchParams(loc.search).get("checkout");
  const polled = useRef(0);
  useEffect(() => {
    if (!outcome) return;
    if (outcome === "success") toast("Thanks! Your plan updates as soon as Stripe confirms the payment.");
    else if (outcome === "changed") toast("Plan change confirmed; it shows here in a moment.");
    else if (outcome === "canceled") toast("Checkout canceled; nothing changed.");
    const planBefore = q.data?.plan.name;
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
        ? `Payment failed; the plan stays until ${day(sub?.graceEndsAt)}. Update your card to keep it.`
        : d.reason === "lapsed"
          ? "Payment failed and the grace period ended: the account is on Free until the card is updated."
          : d.reason === "trialing"
            ? `Trial until ${day(sub?.periodEnd)}.`
            : sub?.cancelAtPeriodEnd
              ? `Cancels on ${day(sub.periodEnd)}; the plan stays until then.`
              : sub?.periodEnd && d.reason === "active"
                ? `Renews on ${day(sub.periodEnd)}${sub.interval ? ` (${sub.interval === "year" ? "yearly" : "monthly"})` : ""}.`
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
      <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-bold">Plan</h2>
          <span className="min-h-4 font-mono text-xs text-ink3">{period ? `Period ${day(period.start)} to ${day(period.end)}` : ""}</span>
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
              {d.plan.price && <span className="font-mono text-sm text-ink2">{sub?.interval === "year" ? `$${d.plan.price.year}/yr` : `$${d.plan.price.month}/mo`}</span>}
              <span className={`chip ${d.watermark.on ? "bg-warn-soft text-warn" : "bg-acc-soft text-acc-text"}`}>{d.watermark.on ? "◇ watermark on" : "◆ no watermark"}</span>
            </div>
            <p className="min-h-5 text-sm text-ink2">{statusLine}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink2">Minutes this period</span>
                {bar(d.usage.MAX_SOURCE_MINUTES_PER_MONTH, minutesCap)}
                <span className="text-xs tabular-nums text-ink3">{minutesCap ? `${num.format(d.usage.MAX_SOURCE_MINUTES_PER_MONTH)} of ${num.format(minutesCap)} min` : `${num.format(d.usage.MAX_SOURCE_MINUTES_PER_MONTH)} min, no cap`}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink2">Storage</span>
                {bar(d.usage.MAX_STORAGE_MB, storageCap)}
                <span className="text-xs tabular-nums text-ink3">{storageCap ? `${gb(d.usage.MAX_STORAGE_MB)} of ${gb(storageCap)}` : `${gb(d.usage.MAX_STORAGE_MB)}, no cap`}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink2">Projects</span>
                {bar(d.usage.MAX_PROJECTS_PER_USER, projectsCap)}
                <span className="text-xs tabular-nums text-ink3">{projectsCap ? `${num.format(d.usage.MAX_PROJECTS_PER_USER)} of ${num.format(projectsCap)}` : `${num.format(d.usage.MAX_PROJECTS_PER_USER)}, no cap`}</span>
              </div>
            </div>
            <div className="flex min-h-9 flex-wrap items-center gap-2">
              <button className="btn-ghost min-w-[9rem]" disabled={!d.canManage || portal.isPending} title={d.canManage ? "Invoices, card, cancel" : "Appears once you have picked a plan"} onClick={() => portal.mutate()}>
                {portal.isPending ? "…" : "Manage billing"}
              </button>
              <span className="text-xs text-ink3">Invoices, payment method and cancellation are on Stripe's portal.</span>
            </div>
          </>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-bold">Plans</h2>
          <div className="flex rounded-[9px] bg-sunk p-0.5" role="group" aria-label="Billing interval">
            {(["month", "year"] as const).map((i) => (
              <button key={i} type="button" className={`h-7 min-w-[5.5rem] rounded-[7px] px-3 text-xs font-semibold ${intervalShown === i ? "bg-panel text-ink shadow-sm" : "text-ink2"}`} aria-pressed={intervalShown === i} onClick={() => setInterval_(i)}>
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
                <div className="font-mono text-[22px] font-bold tracking-tight">{p.price ? (intervalShown === "year" ? `$${p.price.year}` : `$${p.price.month}`) : "$0"}<span className="text-xs font-normal text-ink3">{p.price ? (intervalShown === "year" ? " / year" : " / month") : ""}</span></div>
                <p className="min-h-10 text-xs text-ink2">{p.blurb}</p>
                <ul className="flex flex-col gap-1 text-xs text-ink2">
                  {p.firstVideoFreeMinutes > 0 && <li>First video free up to {p.firstVideoFreeMinutes} minutes</li>}
                  <li>{p.limits.MAX_SOURCE_MINUTES_PER_MONTH ? `${num.format(p.limits.MAX_SOURCE_MINUTES_PER_MONTH)} minutes of video a month` : "Unlimited minutes"}</li>
                  <li>{p.limits.MAX_STORAGE_MB ? `${gb(p.limits.MAX_STORAGE_MB)} of storage` : "Unlimited storage"}</li>
                  <li>{p.limits.MAX_PROJECTS_PER_USER ? `${num.format(p.limits.MAX_PROJECTS_PER_USER)} projects` : "Unlimited projects"}</li>
                  <li>{p.watermark ? "Small watermark" : "No watermark"}</li>
                  {p.priority && <li>Priority processing queue</li>}
                </ul>
                <div className="mt-auto pt-2">
                  {p.price ? (
                    <button className={`${d?.plan.name === p.name ? "btn-ghost" : "btn-ink"} h-9 w-full`} disabled={checkout.isPending || !d || (d.plan.name === p.name && (d.subscription?.interval ?? "month") === intervalShown)} onClick={() => checkout.mutate({ plan: p.name, interval: intervalShown })}>
                    {checkout.isPending && checkout.variables?.plan === p.name ? "…" : d?.plan.name === p.name ? ((d.subscription?.interval ?? "month") === intervalShown ? "Current plan" : `Switch to ${intervalShown === "year" ? "yearly" : "monthly"}`) : d?.plan.price && d.plan.price.month > p.price.month ? "Downgrade" : "Upgrade"}
                    </button>
                  ) : (
                    <button className="btn-ghost h-9 w-full" disabled title={d?.plan.name === "free" ? "You are on Free" : "Cancel from Manage billing; Free applies when the period ends"}>
                      {d?.plan.name === "free" ? "Current plan" : "Cancel to return here"}
                    </button>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
        <p className="text-xs text-ink3">Prices in USD; tax is added at checkout where it applies. Yearly is ten months for twelve. Changing plans is prorated by Stripe.</p>
      </section>
    </>
  );
}
