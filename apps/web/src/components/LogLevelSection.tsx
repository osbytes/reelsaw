import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { MultiCombobox } from "./MultiCombobox";
import { Select } from "./ui";

const FOR = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "1440", label: "24 hours" },
];
const LEVEL_HINT: Record<string, string> = {
  fatal: "only crashes",
  error: "failures",
  warn: "problems",
  info: "milestones (default)",
  debug: "decisions and inputs",
  trace: "every item",
};

/** One override: a set of modules at one level. */
type Row = { id: number; modules: string[]; level: string };

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
    const byLevel = new Map<string, string[]>();
    for (const p of parts.filter((x) => x.includes("="))) byLevel.set(p.split("=")[1]!, [...(byLevel.get(p.split("=")[1]!) ?? []), p.split("=")[0]!]);
    setRows([...byLevel].map(([level, modules]) => ({ id: nextId.current++, modules, level })));
  }, [s]);

  const done = () => void qc.invalidateQueries({ queryKey: trpc.admin.logLevel.pathKey() });
  const set = useMutation(
    trpc.admin.logLevel.set.mutationOptions({
      onSuccess: (st) => void (toast(st.override ? `Log level ${st.effective}` : "Log level back to .env"), done()),
      onError: (e) => toast.error(e.message),
    }),
  );
  const levels = (s?.levels ?? []).map((l) => ({ value: l, label: l, hint: LEVEL_HINT[l] }));
  const shownGlobal = global ?? s?.envGlobal ?? "info";
  const valid = rows.every((r) => r.modules.length > 0);
  // one {module, level} per module, as the server takes it
  const flat = rows.flatMap((r) => r.modules.map((module) => ({ module, level: r.level as never })));
  const mins = s?.override ? Math.max(1, Math.round((Date.parse(s.override.until) - Date.now()) / 60_000)) : 0;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">Log level</h2>
      <p className="text-sm text-ink2">
        More detail for a while, to explain a wrong result. Pick a level for everything, add a module to change just that part, then choose how long. Debug is
        safe for a few minutes.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          Everything
          <Select ariaLabel="Global log level" className="w-40" value={shownGlobal} onValueChange={setGlobal} options={levels} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          For
          <Select ariaLabel="For how long" className="w-36" value={minutes} onValueChange={setMinutes} options={FOR} />
        </label>
        <button
          type="button"
          className="btn-primary min-w-20"
          disabled={!s || !valid || set.isPending}
          onClick={() => set.mutate({ global: shownGlobal as never, modules: flat, forMinutes: Number(minutes) as 15 })}
        >
          Apply
        </button>
        <button
          type="button"
          className="btn-quiet min-w-20"
          disabled={!s?.override || set.isPending}
          onClick={() => (setRows([]), setGlobal(null), set.mutate(null))}
        >
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
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-bold text-ink2">Module overrides</h3>
          <span className="hidden text-[11px] text-ink3 sm:block">Modules · Level</span>
        </div>
        <div className="flex min-h-[38px] flex-col gap-2">
          {rows.length === 0 && <p className="flex min-h-[38px] items-center text-sm text-ink3">No overrides</p>}
          {rows.map((r) => {
            const used = new Set(rows.filter((x) => x.id !== r.id).flatMap((x) => x.modules));
            return (
              <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_2rem] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_8.5rem_2rem]">
                <div className="col-start-1 row-start-1 min-w-0">
                  <MultiCombobox
                    label="Modules"
                    placeholder="Choose modules"
                    searchPlaceholder="Type to filter…"
                    empty="No such module"
                    options={(s?.modules ?? []).filter((m) => !used.has(m)).map((m) => ({ value: m, label: m }))}
                    value={r.modules}
                    onChange={(mods) => setRows((all) => all.map((x) => (x.id === r.id ? { ...x, modules: mods } : x)))}
                  />
                </div>
                <Select
                  ariaLabel="Level"
                  className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1"
                  value={r.level}
                  onValueChange={(l) => setRows((all) => all.map((x) => (x.id === r.id ? { ...x, level: l } : x)))}
                  options={levels}
                />
                <button
                  type="button"
                  className="btn-quiet col-start-2 row-start-1 h-[38px] w-8 px-0 sm:col-start-3"
                  aria-label="Remove override"
                  onClick={() => setRows((all) => all.filter((x) => x.id !== r.id))}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
        <div>
          <button
            type="button"
            className="btn-quiet text-xs"
            disabled={!s}
            onClick={() => setRows((all) => [...all, { id: nextId.current++, modules: [], level: "debug" }])}
          >
            Add override
          </button>
        </div>
      </div>
    </section>
  );
}
