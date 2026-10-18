import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { Combobox, Select } from "./ui";

const FOR = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "1440", label: "24 hours" },
];
const LEVEL_HINT: Record<string, string> = { fatal: "only crashes", error: "failures", warn: "problems", info: "milestones (default)", debug: "decisions and inputs", trace: "every item" };

type Row = { id: number; module: string; level: string };

/**
 * Settings → System → Log level (admins). Turn up the detail for everything, or for parts (a module
 * such as `render`), for a while; it returns to the .env level by itself. Only valid choices are offered.
 */
export function LogLevelSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery({ ...trpc.admin.logLevel.get.queryOptions(), refetchInterval: 15_000 });
  const s = q.data;
  const [global, setGlobal] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [minutes, setMinutes] = useState("15");
  const nextId = useRef(1);
  const seeded = useRef(false);
  // start from the override in force (once), so editing it is one change away
  useEffect(() => {
    if (!s || seeded.current) return;
    seeded.current = true;
    if (!s.override) return;
    const parts = s.override.spec.split(",").map((p) => p.trim());
    const g = parts.find((p) => !p.includes("="));
    if (g) setGlobal(g);
    setRows(parts.filter((p) => p.includes("=")).map((p) => ({ id: nextId.current++, module: p.split("=")[0]!, level: p.split("=")[1]! })));
  }, [s]);

  const done = () => void qc.invalidateQueries({ queryKey: trpc.admin.logLevel.pathKey() });
  const set = useMutation(trpc.admin.logLevel.set.mutationOptions({ onSuccess: (st) => void (toast(st.override ? `Log level ${st.effective}` : "Log level back to .env"), done()), onError: (e) => toast.error(e.message) }));
  const levels = (s?.levels ?? []).map((l) => ({ value: l, label: l, hint: LEVEL_HINT[l] }));
  const shownGlobal = global ?? s?.envGlobal ?? "info";
  const valid = rows.every((r) => r.module);
  const mins = s?.override ? Math.max(1, Math.round((Date.parse(s.override.until) - Date.now()) / 60_000)) : 0;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">Log level</h2>
      <p className="text-sm text-ink2">More detail for a while, to explain a wrong result. Pick a level for everything, add a module to change just that part, then choose how long. Debug is safe for a few minutes.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          Everything
          <Select ariaLabel="Global log level" className="w-40" value={shownGlobal} onValueChange={setGlobal} options={levels} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          For
          <Select ariaLabel="For how long" className="w-36" value={minutes} onValueChange={setMinutes} options={FOR} />
        </label>
        <button type="button" className="btn-primary min-w-20" disabled={!s || !valid || set.isPending} onClick={() => set.mutate({ global: shownGlobal as never, modules: rows.map((r) => ({ module: r.module, level: r.level as never })), forMinutes: Number(minutes) as 15 })}>
          Apply
        </button>
        <button type="button" className="btn-quiet min-w-20" disabled={!s?.override || set.isPending} onClick={() => (setRows([]), setGlobal(null), set.mutate(null))}>
          Reset
        </button>
      </div>
      <p className="min-h-5 text-xs text-ink3" aria-live="polite">
        {s ? (
          <>
            Effective: <span className="font-mono">{s.effective.replace(/,/g, ", ")}</span>
            {s.override ? ` · reverts in ${mins} min` : ""} · default (.env): <span className="font-mono">{s.env.replace(/,/g, ", ")}</span>
          </>
        ) : (
          ""
        )}
      </p>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2">
            <Combobox ariaLabel="Module" className="w-48 font-mono" placeholder="Choose a module" emptyText="No such module" value={r.module} options={(s?.modules ?? []).map((m) => ({ value: m, label: m }))} onValueChange={(m) => setRows((all) => all.map((x) => (x.id === r.id ? { ...x, module: m } : x)))} />
            <Select ariaLabel={`Level for ${r.module || "module"}`} className="w-32" value={r.level} onValueChange={(l) => setRows((all) => all.map((x) => (x.id === r.id ? { ...x, level: l } : x)))} options={levels} />
            <button type="button" className="btn-quiet px-2" aria-label={`Remove ${r.module || "module"} override`} onClick={() => setRows((all) => all.filter((x) => x.id !== r.id))}>
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        <div>
          <button type="button" className="btn-quiet text-xs" disabled={!s} onClick={() => setRows((all) => [...all, { id: nextId.current++, module: "", level: "debug" }])}>
            Add module override
          </button>
        </div>
      </div>
    </section>
  );
}
