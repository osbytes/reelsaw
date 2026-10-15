import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted">{k}</span>
      <span className="truncate font-mono text-xs">{v}</span>
    </div>
  );
}

export function SettingsPage() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.settings.get.queryOptions(), refetchInterval: 5000 });
  const s = q.data;
  if (!s) return <p className="text-muted">Loading…</p>;
  const r = s.resources;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="text-xs text-muted">Configuration comes from the environment (12-factor). Edit <code>.env</code> and restart to change it.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">Models</h2>
          <Row k="Language model" v={s.aiModel} />
          <Row k="Transcription" v={s.transcriptionModel} />
          {s.openaiBaseUrl && <Row k="OpenAI base URL" v={s.openaiBaseUrl} />}
          {s.compatBaseUrl && <Row k="Compat base URL" v={s.compatBaseUrl} />}
          <Row k="Face detection" v={s.faceDetection ? "on" : "off"} />
        </div>
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">Runtime</h2>
          <Row k="Storage" v={s.storage} />
          <Row k="Render concurrency" v={s.renderConcurrency} />
          <Row k="Signups" v={s.allowSignup ? "open" : "closed"} />
          <Row k="OpenTelemetry" v={s.otel ? "on" : "off"} />
          <Row k="Max upload" v={`${s.maxUploadMb} MB`} />
        </div>
        <div className="card p-4 sm:col-span-2">
          <h2 className="mb-2 text-sm font-semibold">Resources <span className="font-normal text-muted">(live)</span></h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Meter label={`CPU ${r.cpuPercent}% busy · ${r.cpus} cpus${r.load1 !== null ? ` · load ${r.load1}` : ""}`} value={r.cpuPercent} ok={r.ok.cpu} />
            <Meter label={`Memory ${r.memTotalMB - r.memAvailableMB} / ${r.memTotalMB} MB`} value={pct(r.memTotalMB - r.memAvailableMB, r.memTotalMB)} ok={r.ok.memory} />
            <Meter label={r.diskFreeMB >= 0 ? `Disk ${r.diskTotalMB - r.diskFreeMB} / ${r.diskTotalMB} MB` : "Disk n/a"} value={r.diskFreeMB >= 0 ? pct(r.diskTotalMB - r.diskFreeMB, r.diskTotalMB) : 0} ok={r.ok.disk} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Meter({ label, value, ok }: { label: string; value: number; ok: boolean }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className={ok ? "text-ok" : "text-danger"}>{ok ? "ok" : "throttling"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-panel-2">
        <div className={`h-full ${ok ? "bg-accent-2" : "bg-danger"}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
