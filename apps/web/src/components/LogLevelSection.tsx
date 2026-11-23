import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useTRPC } from "../lib/trpc";
import { MultiCombobox } from "./MultiCombobox";
import { Select } from "./ui";

const FOR: { value: string; label: MessageDescriptor }[] = [
  { value: "15", label: msg`15 minutes` },
  { value: "60", label: msg`1 hour` },
  { value: "240", label: msg`4 hours` },
  { value: "1440", label: msg`24 hours` },
];
const LEVEL_HINT: Record<string, MessageDescriptor> = {
  fatal: msg`only crashes`,
  error: msg`failures`,
  warn: msg`problems`,
  info: msg`milestones (default)`,
  debug: msg`decisions and inputs`,
  trace: msg`every item`,
};

/** One override: a set of modules at one level. */
type Row = { id: number; modules: string[]; level: string };

/**
 * Settings → System → Log level (admins). Turn up the detail for everything, or for parts (a module
 * such as `render`), for a while; it returns to the .env level by itself. Only valid choices are offered.
 */
export function LogLevelSection() {
  const { t } = useLingui();
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
      onSuccess: (st) => {
        const effective = st.effective;
        toast(st.override ? t`Log level ${effective}` : t`Log level back to .env`);
        done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const levels = (s?.levels ?? []).map((l) => {
    const hint = LEVEL_HINT[l];
    return { value: l, label: l, hint: hint ? i18n._(hint) : undefined };
  });
  const forOptions = FOR.map((o) => ({ value: o.value, label: i18n._(o.label) }));
  const shownGlobal = global ?? s?.envGlobal ?? "info";
  const valid = rows.every((r) => r.modules.length > 0);
  // one {module, level} per module, as the server takes it
  const flat = rows.flatMap((r) => r.modules.map((module) => ({ module, level: r.level as never })));
  const effective = s?.effective.replace(/,/g, ", ") ?? "";
  const env = s?.env.replace(/,/g, ", ") ?? "";
  const mins = s?.override ? Math.max(1, Math.round((Date.parse(s.override.until) - Date.now()) / 60_000)) : 0;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">
        <Trans>Log level</Trans>
      </h2>
      <p className="text-sm text-ink2">
        <Trans>
          More detail for a while, to explain a wrong result. Pick a level for everything, add a module to change just that part, then choose how long. Debug is
          safe for a few minutes.
        </Trans>
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          <Trans>Everything</Trans>
          <Select ariaLabel={t`Global log level`} className="w-40" value={shownGlobal} onValueChange={setGlobal} options={levels} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          <Trans>For</Trans>
          <Select ariaLabel={t`For how long`} className="w-36" value={minutes} onValueChange={setMinutes} options={forOptions} />
        </label>
        <button
          type="button"
          className="btn-primary min-w-20"
          disabled={!s || !valid || set.isPending}
          onClick={() => set.mutate({ global: shownGlobal as never, modules: flat, forMinutes: Number(minutes) as 15 })}
        >
          <Trans>Apply</Trans>
        </button>
        <button
          type="button"
          className="btn-quiet min-w-20"
          disabled={!s?.override || set.isPending}
          onClick={() => (setRows([]), setGlobal(null), set.mutate(null))}
        >
          <Trans>Reset</Trans>
        </button>
      </div>
      <p className="min-h-5 text-xs text-ink3" aria-live="polite">
        {s ? (
          s.override ? (
            <Trans>
              Effective: <span className="font-mono">{effective}</span> · reverts in {mins} min · default (.env): <span className="font-mono">{env}</span>
            </Trans>
          ) : (
            <Trans>
              Effective: <span className="font-mono">{effective}</span> · default (.env): <span className="font-mono">{env}</span>
            </Trans>
          )
        ) : (
          ""
        )}
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-bold text-ink2">
            <Trans>Module overrides</Trans>
          </h3>
          <span className="hidden text-[11px] text-ink3 sm:block">
            <Trans>Modules · Level</Trans>
          </span>
        </div>
        <div className="flex min-h-[38px] flex-col gap-2">
          {rows.length === 0 && (
            <p className="flex min-h-[38px] items-center text-sm text-ink3">
              <Trans>No overrides</Trans>
            </p>
          )}
          {rows.map((r) => {
            const used = new Set(rows.filter((x) => x.id !== r.id).flatMap((x) => x.modules));
            return (
              <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_2rem] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_8.5rem_2rem]">
                <div className="col-start-1 row-start-1 min-w-0">
                  <MultiCombobox
                    label={t`Modules`}
                    placeholder={t`Choose modules`}
                    searchPlaceholder={t`Type to filter…`}
                    empty={t`No such module`}
                    options={(s?.modules ?? []).filter((m) => !used.has(m)).map((m) => ({ value: m, label: m }))}
                    value={r.modules}
                    onChange={(mods) => setRows((all) => all.map((x) => (x.id === r.id ? { ...x, modules: mods } : x)))}
                  />
                </div>
                <Select
                  ariaLabel={t`Level`}
                  className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1"
                  value={r.level}
                  onValueChange={(l) => setRows((all) => all.map((x) => (x.id === r.id ? { ...x, level: l } : x)))}
                  options={levels}
                />
                <button
                  type="button"
                  className="btn-quiet col-start-2 row-start-1 h-[38px] w-8 px-0 sm:col-start-3"
                  aria-label={t`Remove override`}
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
            <Trans>Add override</Trans>
          </button>
        </div>
      </div>
    </section>
  );
}
