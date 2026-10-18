import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { Select } from "./ui";

const FOR = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
];

/**
 * Settings → System → Log level (admins). Turn up the detail (`debug`, or one part such as `render=debug`)
 * for a while to see why something went wrong, then it returns to the .env level by itself.
 */
export function LogLevelSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery({ ...trpc.admin.logLevel.get.queryOptions(), refetchInterval: 15_000 });
  const [spec, setSpec] = useState("debug");
  const [minutes, setMinutes] = useState("15");
  const done = () => void qc.invalidateQueries({ queryKey: trpc.admin.logLevel.pathKey() });
  const set = useMutation(trpc.admin.logLevel.set.mutationOptions({ onSuccess: (st) => void (toast(st.override ? `Log level ${st.effective} until ${new Date(st.override.until).toLocaleTimeString()}` : "Log level back to .env"), done()), onError: (e) => toast.error(e.message) }));
  const s = q.data;
  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-bold">Log level</h2>
        <span className="min-h-5 font-mono text-xs text-ink3">{s ? `now ${s.effective}${s.override ? ` · until ${new Date(s.override.until).toLocaleTimeString()}` : ""}` : ""}</span>
      </div>
      <p className="text-sm text-ink2">More detail for a while, to explain a wrong result. A level (<code>debug</code>) or parts (<code>render=debug,http=warn</code>); it returns to <code>{s?.env ?? "the .env level"}</code> by itself. Debug is safe for a few minutes.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-64 font-mono text-sm" aria-label="Log level" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="render=debug" />
        <Select ariaLabel="For how long" className="w-36" value={minutes} onValueChange={setMinutes} options={FOR} />
        <button type="button" className="btn-primary min-w-20" disabled={!spec.trim() || set.isPending} onClick={() => set.mutate({ spec, minutes: Number(minutes) })}>
          Apply
        </button>
        <button type="button" className="btn-quiet min-w-20" disabled={!s?.override || set.isPending} onClick={() => set.mutate({ spec: null, minutes: 15 })}>
          Reset
        </button>
      </div>
    </section>
  );
}
