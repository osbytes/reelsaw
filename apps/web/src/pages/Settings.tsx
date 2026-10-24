import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation } from "react-router";
import { useTRPC } from "../lib/trpc";
import { ScrollArea } from "../components/scroll-area";
import { ApiKeysSection } from "../components/ApiKeys";
import { AccountSection } from "../components/AccountSection";
import { ProjectDefaultsSection } from "../components/ProjectDefaults";
import { useMe, useSystemStatus } from "../lib/account";
import { ProcessingTimes } from "../components/ProcessingTimes";
import { WorkersOnlineLine, WorkersSection } from "../components/WorkersSection";
import { QueueSection } from "../components/QueueSection";
import { ModelsSection } from "../components/ModelsSection";
import { LogLevelSection } from "../components/LogLevelSection";
import { Skeleton, SkeletonRegion } from "../components/ui";
import { UpdateBanner, UpdateStatusLine } from "../components/UpdateNotice";
import { ACCESS_FIELDS, InstanceSettingsGroup, LIBRARY_FIELDS, LIMIT_FIELDS, OPERATIONS_FIELDS, PIPELINE_FIELDS, RETENTION_FIELDS } from "../components/InstanceSettings";
import { BILLING_PATH, CHANGELOG_URL, REPO_URL } from "@reelsaw/shared";

// enterprise edition (src/ee, its own licence): the chunk is only requested when me.get says billing runs here
const BillingSection = lazy(() => import("../ee/billing/BillingSection"));

function gb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** The System tab's sections, in page order; the side nav links to them and the URL hash deep-links one. */
const SYSTEM_SECTIONS = [
  ["overview", "Overview"],
  ["workers", "Workers"],
  ["queue", "Queue"],
  ["models", "Models"],
  ["access", "Access"],
  ["limits", "Limits"],
  ["pipeline", "Pipeline"],
  ["retention", "Retention"],
  ["operations", "Operations"],
  ["log-level", "Log level"],
] as const;

/**
 * Settings has two tabs: Account (everyone: profile, project defaults, API keys) and System (admins:
 * what this machine runs and the instance settings that can change without a restart). /settings and
 * /settings/system are the tabs; #access etc. deep-links a System section.
 */
export function SettingsPage() {
  const me = useMe();
  const status = useSystemStatus();
  const loc = useLocation();
  const isAdmin = me.data?.role === "admin";
  const hasBilling = !!me.data?.ee?.billing;
  const system = loc.pathname.endsWith("/system") && isAdmin;
  const billing = loc.pathname === BILLING_PATH && hasBilling;
  const tab = ({ isActive }: { isActive: boolean }) => `rounded-[9px] px-3 py-[7px] text-[13px] whitespace-nowrap no-underline ${isActive ? "bg-sunk font-semibold text-ink" : "text-ink2 hover:text-ink"}`;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className={`mx-auto flex flex-col gap-6 px-4 py-7 sm:px-6 ${system ? "max-w-[1180px]" : "max-w-[960px]"}`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h1 className="text-[28px] font-bold tracking-tight">Settings</h1>
              <span className="min-h-5 font-mono text-xs text-ink3">
                {status.data ? (
                  <>
                    <a href={CHANGELOG_URL} target="_blank" rel="noreferrer" className="text-ink3 no-underline hover:text-acc-text">
                      Reelsaw {status.data.version}
                    </a>
                    {" · "}
                    <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-ink3 no-underline hover:text-acc-text">
                      github.com/osbytes/reelsaw
                    </a>
                  </>
                ) : null}
              </span>
            </div>
            <p className="mt-1 min-h-5 text-sm text-ink2">
              {system ? "This machine and this instance. Models, access, limits, pipeline, retention and operations change here without a restart; the rest comes from .env." : billing ? "Your plan, what you have used this period, and the plans on offer." : "Your account, your defaults for new projects, and keys for agents and tools."}
            </p>
          </div>
          {/* the tab row keeps its height for everyone, so the page does not jump when the role loads */}
          <nav className="flex min-h-[34px] gap-1" aria-label="Settings tabs">
            {(isAdmin || hasBilling) && (
              <NavLink to="/settings" end className={tab}>
                Account
              </NavLink>
            )}
            {hasBilling && (
              <NavLink to={BILLING_PATH} className={tab}>
                Billing
              </NavLink>
            )}
            {isAdmin && (
              <NavLink to="/settings/system" className={tab}>
                System
              </NavLink>
            )}
          </nav>
        </div>
        {system ? (
          <SystemTab />
        ) : billing ? (
          <Suspense
            fallback={
              <SkeletonRegion className="flex flex-col gap-6">
                <Skeleton className="h-40 w-full rounded-[16px]" />
                <Skeleton className="h-72 w-full rounded-[16px]" />
              </SkeletonRegion>
            }
          >
            <BillingSection />
          </Suspense>
        ) : (
          <>
            <AccountSection />
            <ProjectDefaultsSection />
            <ApiKeysSection mcpUrl={`${window.location.origin}/api/mcp`} />
          </>
        )}
      </main>
    </ScrollArea>
  );
}

/** Section id from `#queue` or `#queue&fail=clip:…` (Failed work keeps extra hash params). */
function sectionFromHash(hash = window.location.hash): string {
  const head = (hash.replace(/^#/, "").split("&")[0] ?? "").replace(/=$/, "");
  return head && !head.includes("=") ? head : "";
}

/** Which section is on screen, for the side nav; the hash follows without adding history entries. */
function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState<string>(() => sectionFromHash() || ids[0]!);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id);
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

/** "text, alignment on cpu; vad on cpu (always)" or, when a GPU provider was asked for, which models got it. */
function onDeviceSummary(d: { requested: string; faces: string | null; text: string | null; vad: string | null; aligner: string | null }) {
  const on = (["text", "aligner", "vad"] as const).filter((k) => d[k]);
  if (!on.length) return "all off";
  const byProvider = new Map<string, string[]>();
  for (const k of on) byProvider.set(d[k]!, [...(byProvider.get(d[k]!) ?? []), k === "aligner" ? "alignment" : k]);
  const parts = [...byProvider].map(([p, ks]) => `${ks.join(", ")} on ${p}`);
  return d.requested !== "cpu" && !on.some((k) => d[k] === d.requested) ? `${parts.join("; ")} (${d.requested} unavailable)` : parts.join("; ");
}

function jumpTo(id: string, smooth = true) {
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  history.replaceState(null, "", `#${id}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function SystemTab() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.admin.system.queryOptions(), refetchInterval: 5000 });
  const s = q.data;
  const ids = SYSTEM_SECTIONS.map(([id]) => id);
  const active = useActiveSection(ids);
  // a deep link (#access, or #queue&fail=…) lands on its section once the content exists; keep extra hash params
  useEffect(() => {
    const section = sectionFromHash();
    if (section && ids.includes(section as never)) {
      document.getElementById(section)?.scrollIntoView({ behavior: "auto", block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!s]);

  const r = s?.resources;
  const L = s?.limits;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const gauges = r
    ? [
        {
          name: "CPU",
          val: `${r.cpuPercent}%`,
          used: r.cpuPercent,
          limit: L?.maxCpuPercent,
          ok: r.ok.cpu,
          note: `${r.cpus} cores${r.load1 !== null ? ` · load ${r.load1}` : ""}${L ? ` · heavy jobs wait above ${L.maxCpuPercent}%` : ""}`,
        },
        {
          name: "Memory",
          val: `${pct(r.memTotalMB - r.memAvailableMB, r.memTotalMB)}%`,
          used: pct(r.memTotalMB - r.memAvailableMB, r.memTotalMB),
          limit: L ? 100 - pct(L.minFreeMemMB, r.memTotalMB) : undefined,
          ok: r.ok.memory,
          note: `${gb(r.memTotalMB - r.memAvailableMB)} of ${gb(r.memTotalMB)}${L ? ` · keeps ${gb(L.minFreeMemMB)} free` : ""}`,
        },
        {
          name: "Disk",
          val: r.diskFreeMB >= 0 ? `${pct(r.diskTotalMB - r.diskFreeMB, r.diskTotalMB)}%` : "n/a",
          used: r.diskFreeMB >= 0 ? pct(r.diskTotalMB - r.diskFreeMB, r.diskTotalMB) : 0,
          limit: L && r.diskTotalMB > 0 ? 100 - pct(L.minFreeDiskMB, r.diskTotalMB) : undefined,
          ok: r.ok.disk,
          note: r.diskFreeMB >= 0 ? `${gb(r.diskFreeMB)} free of ${gb(r.diskTotalMB)}` : "Not measurable on this filesystem",
        },
      ]
    : [];

  /** Facts that come from .env and need a restart to change; shown so an admin knows what this box runs. */
  const env = s
    ? [
        ["Storage", s.storage],
        ["Render concurrency", s.renderConcurrency.mode === "auto" ? `automatic · ${s.renderConcurrency.running} running, up to ${s.renderConcurrency.max}` : `${s.renderConcurrency.max} (fixed)`],
        ["Email", s.email],
        ["OpenAI base URL", s.openaiBaseUrl ?? "api.openai.com"],
        ["Compatible base URL", s.compatBaseUrl ?? "not set"],
        ["GPU", s.gpu ? `${s.gpu.vendor}: ${s.gpu.devices.join(", ") || "device present, no driver tools"}` : "none visible to this process"],
        ["Video encoder", `${s.videoEncoder.name} · ${s.videoEncoder.reason}`],
        ["Face detection", s.faceDetection ? `on · ${s.onDevice.faces}` : "off"],
        ["On-device models", onDeviceSummary(s.onDevice)],
        ["OpenTelemetry", s.otel ? "on" : "off"],
        ["MCP endpoint", s.mcpUrl],
      ]
    : [];

  return (
    <div className="flex flex-col gap-4 md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-6">
      {/* side nav: a sticky column on wide screens (the grid cell spans the whole content, so it can follow), a scrollable row on phones */}
      <div className="md:sticky md:top-0 md:self-start md:pt-1">
      <ScrollArea className="-mx-4 px-4 md:mx-0 md:px-0">
        <nav className="flex gap-1 pb-1 md:flex-col md:pb-0" aria-label="System sections">
          {SYSTEM_SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={active === id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jumpTo(id);
              }}
              className={`rounded-[9px] px-3 py-[7px] text-[13px] whitespace-nowrap no-underline ${active === id ? "bg-sunk font-semibold text-ink" : "text-ink2 hover:text-ink"}`}
            >
              {label}
            </a>
          ))}
        </nav>
      </ScrollArea>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <section id="overview" className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-[15px] font-bold">Overview</h2>
            <UpdateStatusLine version={s ? `${s.version.version} · ${s.version.commit}` : null} />
          </div>
          <UpdateBanner />
          {!r ? (
            <SkeletonRegion label="Loading system status…" className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-3">
                {["w-4/5", "w-3/5", "w-2/3"].map((w, i) => (
                  <div key={i} className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between">
                      <Skeleton className="h-4 w-14" />
                      <Skeleton className="h-4 w-9" />
                    </div>
                    <Skeleton className="h-2 w-full rounded-full" />
                    <Skeleton className={`h-3.5 ${w}`} />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="contents">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className={`h-3.5 justify-self-end ${["w-24", "w-40", "w-16"][i % 3]}`} />
                  </div>
                ))}
              </div>
            </SkeletonRegion>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                {gauges.map((g) => (
                  <div key={g.name} className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between">
                      <b>{g.name}</b>
                      <span className={`font-mono text-sm ${g.ok ? "" : "text-warn"}`}>{g.val}</span>
                    </div>
                    <div className="relative h-2 rounded-full bg-sunk">
                      <div className={`h-full rounded-full ${g.ok ? "bg-acc" : "bg-warn"}`} style={{ width: `${Math.min(100, g.used)}%` }} />
                      {g.limit !== undefined && g.limit > 0 && g.limit < 100 && <div title="Pause threshold" className="absolute -top-1 h-4 w-0.5 rounded-full bg-ink" style={{ left: `${g.limit}%` }} />}
                    </div>
                    <div className="text-xs text-ink2">
                      {g.ok ? "" : "◷ Jobs paused · "}
                      {g.note}
                    </div>
                  </div>
                ))}
              </div>
              <WorkersOnlineLine />
              <ProcessingTimes />
              <div>
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[13px] font-bold">From .env</h3>
                  <span className="text-xs text-ink3">changes need a restart</span>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  {env.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-ink2">{k}</dt>
                      <dd className="truncate text-right font-mono text-xs leading-5" title={v}>
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}
        </section>

        <WorkersSection />
        <QueueSection />

        <div id="models" className="scroll-mt-4">
          <ModelsSection />
        </div>

        <InstanceSettingsGroup id="access" title="Access" intro="Who gets in and what the sign-up form asks for. Applies to the next sign-up or sign-in." fields={ACCESS_FIELDS} />
        <InstanceSettingsGroup id="limits" title="Limits" intro="Per-account quotas (0 = unlimited; override one account on the Users page) and what a source may weigh." fields={LIMIT_FIELDS} />
        <InstanceSettingsGroup
          id="pipeline"
          title="Pipeline"
          intro="Refine-stage ceilings for every account. Off by default. Turn a gate on so projects (and Project defaults) may opt into that step; leave off to keep every account on the fast path."
          fields={PIPELINE_FIELDS}
        />
        <InstanceSettingsGroup id="retention" title="Retention" intro="How long files and history stay. Sweeps run every few minutes; a shorter number removes what is already older on the next sweep." fields={RETENTION_FIELDS} />
        <InstanceSettingsGroup id="operations" title="Operations" intro="Watchdog, update checks and what the health endpoint tells anonymous callers." fields={OPERATIONS_FIELDS} />
        <InstanceSettingsGroup id="library" title="Library" intro="Where Browse finds sounds, icons and media. The Reelsaw catalog and Iconify need nothing; paste a free key to switch a provider on. Keys are stored encrypted and never shown again." fields={LIBRARY_FIELDS} />

        <div id="log-level" className="scroll-mt-4">
          <LogLevelSection />
        </div>
      </div>
    </div>
  );
}
