import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { ScrollArea } from "../components/scroll-area";
import { ApiKeysSection } from "../components/ApiKeys";
import { AccountSection } from "../components/AccountSection";
import { ProjectDefaultsSection } from "../components/ProjectDefaults";
import { useMe, useSystemStatus } from "../lib/account";
import { ProcessingTimes } from "../components/ProcessingTimes";
import { ModelsSection } from "../components/ModelsSection";
import { LogLevelSection } from "../components/LogLevelSection";
import { Skeleton, SkeletonRegion } from "../components/ui";

function gb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export function SettingsPage() {
  const trpc = useTRPC();
  const me = useMe();
  const status = useSystemStatus();
  const isAdmin = me.data?.role === "admin";
  const q = useQuery({ ...trpc.admin.system.queryOptions(), refetchInterval: 5000, enabled: isAdmin });
  const s = q.data;
  const mcpUrl = `${window.location.origin}/api/mcp`;
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

  const cfg = s
    ? [
        {
          title: "Model servers",
          rows: [
            ["OpenAI base URL", s.openaiBaseUrl ?? "api.openai.com"],
            ["Compatible base URL", s.compatBaseUrl ?? "not set"],
            ["Face detection", s.faceDetection ? "on" : "off"],
          ],
        },
        {
          title: "Runtime",
          rows: [
            ["Storage", s.storage],
            ["Render concurrency", s.renderConcurrency.mode === "auto" ? `Automatic · ${s.renderConcurrency.running} running, up to ${s.renderConcurrency.max}` : `${s.renderConcurrency.max} (fixed)`],
            ["Max upload", `${s.maxUploadMb} MB`],
            ["Sign-ups", s.signupMode === "approval" ? "need approval" : s.signupMode],
            ["Email", s.email],
            ["Health details", s.healthDetails ? "public" : "admins only"],
            ["OpenTelemetry", s.otel ? "on" : "off"],
          ],
        },
      ]
    : [];

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[960px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h1 className="text-[28px] font-bold tracking-tight">Settings</h1>
            <span className="min-h-5 font-mono text-xs text-ink3">{status.data ? `Reelsaw ${status.data.version}` : ""}</span>
          </div>
          <p className="mt-1 min-h-5 text-sm text-ink2">{isAdmin ? "Your account and defaults, then this machine: models can be switched here; keys, servers and limits come from .env (change and restart)." : "Your account, project defaults and API keys."}</p>
        </div>
        <AccountSection />
        <ProjectDefaultsSection />
        <ApiKeysSection mcpUrl={mcpUrl} />
        {isAdmin && (
          <div className="flex items-baseline gap-2 pt-2">
            <h2 className="text-[18px] font-bold tracking-tight">System</h2>
            <span className="min-h-5 font-mono text-xs text-ink3">{s ? `${s.version.version} · ${s.version.commit}` : ""}</span>
          </div>
        )}
        {isAdmin && !s && (
          <SkeletonRegion label="Loading system status…" className="flex flex-col gap-6">
            <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
              <Skeleton className="h-5 w-24" />
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
            </section>
            <div className="grid gap-4 sm:grid-cols-2">
              {[3, 7].map((n) => (
                <section key={n} className="flex flex-col gap-2 rounded-[16px] border border-line bg-panel p-5">
                  <Skeleton className="h-5 w-28" />
                  {Array.from({ length: n }, (_, i) => (
                    <div key={i} className="flex h-5 items-center justify-between gap-4">
                      <Skeleton className="h-3.5 w-24" />
                      <Skeleton className={`h-3.5 ${["w-20", "w-28", "w-16"][i % 3]}`} />
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </SkeletonRegion>
        )}
        {r && (
          <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[15px] font-bold">Machine</h2>
              <span className="text-xs text-ink3">updates live</span>
            </div>
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
            <ProcessingTimes />
          </section>
        )}
        {isAdmin && <ModelsSection />}
        {isAdmin && <LogLevelSection />}
        <div className="grid gap-4 sm:grid-cols-2">
          {cfg.map((sec) => (
            <section key={sec.title} className="flex flex-col gap-2 rounded-[16px] border border-line bg-panel p-5">
              <h2 className="text-[15px] font-bold">{sec.title}</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                {sec.rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-ink2">{k}</dt>
                    <dd className="truncate text-right font-mono text-xs leading-5">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </main>
    </ScrollArea>
  );
}
