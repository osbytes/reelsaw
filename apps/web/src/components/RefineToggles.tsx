/**
 * Project / defaults toggles for refine steps. Instance gates (me.refineGates) are ceilings:
 * when a gate is off, the control is disabled and explains that the server has it off.
 */
import type { ProjectSettings } from "@reelsaw/shared";
import { useMe } from "../lib/account";
import { Select } from "./ui";

type RefineKey = "refineEntities" | "refineDisfluency" | "disfluencyLlm" | "refineScenes";
type GateKey = "entities" | "disfluency" | "disfluencyLlm" | "scenes";

const ROWS: Array<{ key: RefineKey; gate: GateKey; label: string; help: string; needs?: RefineKey }> = [
  { key: "refineEntities", gate: "entities", label: "Fix misheard names", help: "Language-model pass after transcription. On by default." },
  { key: "refineDisfluency", gate: "disfluency", label: "Remove fillers and repeats", help: "Find ums, stutters and false starts. Off by default." },
  { key: "disfluencyLlm", gate: "disfluencyLlm", label: "Model pass for fillers", help: "Extra model check on top of rules. Off by default (rules only when filler removal is on).", needs: "refineDisfluency" },
  { key: "refineScenes", gate: "scenes", label: "On-screen text scan", help: "Find burned-in captions, watermarks and slides so captions avoid them. Shot changes are always detected. On by default." },
];

type Props = {
  value: Pick<ProjectSettings, RefineKey>;
  onChange: (patch: Partial<Pick<ProjectSettings, RefineKey>>) => void;
  /** denser layout for the Advanced section on New project */
  compact?: boolean;
};

export function RefineToggles({ value, onChange, compact }: Props) {
  const me = useMe();
  const gates = me.data?.refineGates;
  return (
    <div className={`flex flex-col ${compact ? "gap-2.5" : "gap-3"}`}>
      {!compact && <span className="text-[13px] font-semibold text-ink2">Refine after transcription</span>}
      {ROWS.map((r) => {
        const gateOn = gates?.[r.gate] !== false;
        const parentOn = !r.needs || value[r.needs] === true;
        const disabled = !gateOn || !parentOn;
        const checked = value[r.key] === true;
        const why = !gateOn ? "Off on this server (Settings → System → Pipeline)." : !parentOn ? "Turn on filler removal first." : undefined;
        return (
          <label key={r.key} className={`flex items-start gap-2.5 text-sm ${disabled ? "opacity-60" : "cursor-pointer"}`} title={why}>
            <input
              type="checkbox"
              className="mt-1 accent-[var(--acc)]"
              checked={checked && gateOn}
              disabled={disabled}
              onChange={(e) => onChange({ [r.key]: e.target.checked })}
            />
            <span>
              <b className="font-semibold">{r.label}</b>
              <br />
              <span className="text-[13px] font-normal text-ink2">{why ?? r.help}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Tri-state for Project defaults: empty = built-in (on), yes/no = saved override. */
export function RefineDefaultsFields({
  value,
  onChange,
  builtIn,
}: {
  value: Partial<Record<RefineKey, boolean>>;
  onChange: (key: RefineKey, v: boolean | undefined) => void;
  builtIn?: Partial<Record<RefineKey, boolean>>;
}) {
  const me = useMe();
  const gates = me.data?.refineGates;
  return (
    <div className="flex flex-col gap-3 sm:col-span-2">
      <div>
        <h3 className="text-[13px] font-bold">Refine after transcription</h3>
        <p className="mt-0.5 text-[13px] text-ink2">Name fixes and the on-screen text scan are on by default; filler removal is off for speed and cost. Empty = built-in. The server must allow a step under Settings → System → Pipeline before a project can run it.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {ROWS.map((r) => {
          const gateOn = gates?.[r.gate] !== false;
          const cur = value[r.key];
          const selectVal = cur === undefined ? "" : cur ? "yes" : "no";
          return (
            <label key={r.key} className={`flex flex-col gap-1 text-xs text-ink2 ${gateOn ? "" : "opacity-60"}`}>
              {r.label}
              <Select
                ariaLabel={r.label}
                disabled={!gateOn}
                value={gateOn ? selectVal : "no"}
                onValueChange={(v) => onChange(r.key, v === "" ? undefined : v === "yes")}
                options={
                  gateOn
                    ? [
                        { value: "", label: `built-in (${builtIn?.[r.key] ? "on" : "off"})` },
                        { value: "yes", label: "on" },
                        { value: "no", label: "off" },
                      ]
                    : [{ value: "no", label: "off on this server" }]
                }
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
