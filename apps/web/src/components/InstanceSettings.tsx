import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC } from "../lib/trpc";
import { ago } from "../lib/time";
import { Notice, Segmented, Select, Skeleton, SkeletonRegion } from "./ui";

type State = inferRouterOutputs<AppRouter>["admin"]["settings"]["get"];
type Patch = inferRouterInputs<AppRouter>["admin"]["settings"]["set"];
type Key = keyof State["values"];

/** How one setting is edited. Help text and validation come from the server (one registry); this is only the control. */
export type Field =
  | { key: Key; label: string; kind: "enum"; options: Array<{ value: string; label: string }> }
  | { key: Key; label: string; kind: "bool"; on?: string; off?: string }
  | { key: Key; label: string; kind: "int"; min?: number; max?: number; unit?: string; zero?: string }
  | { key: Key; label: string; kind: "url" | "text" | "secret"; placeholder?: string };

export const ACCESS_FIELDS: Field[] = [
  { key: "SIGNUP_MODE", label: "Sign-ups", kind: "enum", options: [{ value: "open", label: "Open" }, { value: "approval", label: "Approval" }, { value: "closed", label: "Closed" }] },
  { key: "REQUIRE_EMAIL_VERIFICATION", label: "Email verification", kind: "bool", on: "Required", off: "Off" },
  {
    key: "CAPTCHA_PROVIDER",
    label: "Captcha",
    kind: "enum",
    options: [
      { value: "", label: "Off" },
      { value: "cloudflare-turnstile", label: "Cloudflare Turnstile" },
      { value: "google-recaptcha", label: "Google reCAPTCHA" },
      { value: "hcaptcha", label: "hCaptcha" },
    ],
  },
  { key: "CAPTCHA_SITE_KEY", label: "Captcha site key", kind: "text", placeholder: "public key" },
  { key: "CAPTCHA_SECRET_KEY", label: "Captcha secret key", kind: "secret", placeholder: "not set" },
  { key: "TERMS_URL", label: "Terms of service link", kind: "url", placeholder: "https://… (none)" },
  { key: "PRIVACY_URL", label: "Privacy policy link", kind: "url", placeholder: "https://… (none)" },
];

export const LIMIT_FIELDS: Field[] = [
  { key: "MAX_PROJECTS_PER_USER", label: "Projects kept", kind: "int", unit: "projects", zero: "unlimited" },
  { key: "MAX_SOURCE_MINUTES_PER_DAY", label: "Minutes of video per day", kind: "int", unit: "minutes", zero: "unlimited" },
  { key: "MAX_NEW_PROJECTS_PER_HOUR", label: "New projects per hour", kind: "int", unit: "projects", zero: "unlimited" },
  { key: "MAX_LIVE_JOBS_PER_USER", label: "Jobs at once", kind: "int", unit: "jobs", zero: "unlimited" },
  { key: "MAX_RERENDERS_PER_HOUR", label: "Renders asked for per hour", kind: "int", unit: "renders", zero: "unlimited" },
  { key: "MAX_STORAGE_MB", label: "Storage per account", kind: "int", unit: "MB", zero: "unlimited" },
  { key: "MAX_UPLOAD_MB", label: "Largest upload", kind: "int", min: 1, unit: "MB" },
  { key: "MAX_SOURCE_FILE_MB", label: "Largest link download", kind: "int", min: 1, unit: "MB" },
  { key: "ALLOW_PRIVATE_SOURCE_URLS", label: "Links to private networks", kind: "bool", on: "Allowed", off: "Blocked" },
];

export const RETENTION_FIELDS: Field[] = [
  { key: "SOURCE_RETENTION_DAYS", label: "Keep source videos", kind: "int", unit: "days", zero: "forever" },
  { key: "CLIP_RETENTION_DAYS", label: "Keep rendered clips", kind: "int", unit: "days", zero: "forever" },
  { key: "DELETED_RETENTION_DAYS", label: "Keep deleted items restorable", kind: "int", unit: "days", zero: "forever" },
  { key: "EVENT_RETENTION_DAYS", label: "Keep project events", kind: "int", unit: "days", zero: "forever" },
  { key: "LLM_USAGE_RETENTION_DAYS", label: "Keep usage rows", kind: "int", unit: "days", zero: "forever" },
  { key: "ADMIN_EVENT_RETENTION_DAYS", label: "Keep the admin log", kind: "int", unit: "days", zero: "forever" },
];

export const PIPELINE_FIELDS: Field[] = [
  { key: "TRANSCRIPT_CORRECTION", label: "Name fixes after transcription", kind: "bool", on: "On", off: "Off" },
  { key: "DISFLUENCY_REMOVAL", label: "Filler and repeat removal", kind: "bool", on: "On", off: "Off" },
  { key: "DISFLUENCY_LLM", label: "Model pass for fillers", kind: "bool", on: "On", off: "Rules only" },
  { key: "REFINE_SCENES", label: "Scene cuts and on-screen text", kind: "bool", on: "On", off: "Off" },
];

export const OPERATIONS_FIELDS: Field[] = [
  { key: "STALL_MINUTES", label: "Stall watchdog", kind: "int", min: 2, max: 1440, unit: "minutes" },
  { key: "UPDATE_CHECK", label: "Update check", kind: "bool", on: "On", off: "Off" },
  { key: "HEALTH_DETAILS", label: "Machine numbers in /api/health", kind: "bool", on: "Anyone", off: "Admins only" },
];

/** The settings state, shared by every group on the page (one query). */
export function useInstanceSettings() {
  const trpc = useTRPC();
  return useQuery({ ...trpc.admin.settings.get.queryOptions(), refetchInterval: 15_000 });
}

/** A value as the input shows it: "" for none, numbers as strings, masked secrets as "". */
const shown = (f: Field, v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (f.kind === "secret") return ""; // the tail is shown as the placeholder, never as the value
  return String(v);
};
const describe = (f: Field, v: unknown): string => {
  if (f.kind === "bool") return v ? (f.on ?? "On") : (f.off ?? "Off");
  if (f.kind === "enum") return f.options.find((o) => o.value === (v ?? ""))?.label ?? String(v ?? "none");
  if (f.kind === "int") return v === 0 && f.zero ? f.zero : `${v}${f.unit ? ` ${f.unit}` : ""}`;
  if (f.kind === "secret") return v ? `set (${v})` : "not set";
  return v ? String(v) : "none";
};

/**
 * One group of runtime instance settings (Settings → System → Access / Limits / Retention / Operations).
 * Each row: the label and the server's help on the left, the control on the right with where the value
 * comes from (.env or set here) and a way back to .env. Changes are drafted per group and saved together,
 * because the server validates the result as a whole (a captcha needs both keys).
 */
export function InstanceSettingsGroup({ id, title, intro, fields, children }: { id: string; title: string; intro: string; fields: Field[]; children?: ReactNode }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useInstanceSettings();
  const s = q.data;
  // draft: what the admin typed (string form); null = "back to .env" asked for
  const [draft, setDraft] = useState<Partial<Record<Key, string | null>>>({});
  useEffect(() => setDraft({}), [s?.updatedAt]);

  const save = useMutation(
    trpc.admin.settings.set.mutationOptions({
      onSuccess: (_st, input) => {
        setDraft({});
        const names = fields.filter((f) => f.key in input).map((f) => f.label);
        toast(`Saved: ${names.join(", ")}. Every process applies it within a few seconds.`);
        void qc.invalidateQueries({ queryKey: trpc.admin.settings.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.admin.system.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.system.status.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.admin.updates.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  /** The patch the drafts amount to, or the first reason it cannot be sent. */
  const { patch, problem } = useMemo(() => {
    const patch: Record<string, unknown> = {};
    let problem: string | null = null;
    for (const f of fields) {
      const d = draft[f.key];
      if (d === undefined) continue;
      if (d === null) {
        patch[f.key] = null;
        continue;
      }
      if (f.kind === "int") {
        const n = Number(d);
        if (d.trim() === "" || !Number.isInteger(n) || n < (f.min ?? 0) || (f.max !== undefined && n > f.max)) {
          problem ??= `${f.label}: enter a whole number${f.min !== undefined || f.max !== undefined ? ` between ${f.min ?? 0} and ${f.max ?? "∞"}` : ""}`;
          continue;
        }
        patch[f.key] = n;
      } else if (f.kind === "bool") patch[f.key] = d === "true";
      else patch[f.key] = d;
    }
    return { patch: patch as Patch, problem };
  }, [draft, fields]);
  const dirty = Object.keys(patch).length > 0;

  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
      <div>
        <h2 className="text-[15px] font-bold">{title}</h2>
        <p className="mt-0.5 text-sm text-ink2">{intro}</p>
      </div>
      {!s ? (
        <SkeletonRegion label={`Loading ${title.toLowerCase()}…`} className="flex flex-col divide-y divide-line">
          {fields.map((f) => (
            <div key={f.key} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-3.5 w-24" />
              </div>
            </div>
          ))}
        </SkeletonRegion>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {fields.map((f) => (
            <FieldRow key={f.key} field={f} state={s} draft={draft[f.key]} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} disabled={save.isPending} />
          ))}
        </div>
      )}
      {children}
      {/* always-present footer, so saving never shifts the rows above */}
      <div className="flex min-h-9 flex-wrap items-center justify-end gap-2">
        <span className="mr-auto min-h-5 text-xs text-ink3">{problem ?? (s?.updatedAt ? `Last change ${ago(s.updatedAt)}${s.updatedBy ? ` by ${s.updatedBy}` : ""}` : "")}</span>
        <button type="button" className="btn-quiet" disabled={!dirty || save.isPending} onClick={() => setDraft({})}>
          Discard
        </button>
        <button type="button" className="btn-primary min-w-[6.5rem]" disabled={!dirty || !!problem || save.isPending} onClick={() => save.mutate(patch)}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

function FieldRow({ field: f, state: s, draft, onChange, disabled }: { field: Field; state: State; draft: string | null | undefined; onChange: (v: string | null) => void; disabled: boolean }) {
  const values = s.values as Record<string, unknown>;
  const env = s.env as Record<string, unknown>;
  const source = s.source as Record<string, "env" | "db">;
  const ignored = (s.ignored as Record<string, string | undefined>)[f.key];
  const help = (s.help as Record<string, string>)[f.key];
  const current = values[f.key];
  const resetting = draft === null;
  const value = resetting ? shown(f, env[f.key]) : (draft ?? shown(f, current));
  const fromDb = source[f.key] === "db";
  const inputId = `setting-${f.key}`;

  let control: ReactNode;
  if (f.kind === "enum" && f.options.length <= 3) {
    control = <Segmented value={value} options={f.options.map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => onChange(v)} size="sm" className="w-full" />;
  } else if (f.kind === "enum") {
    control = <Select ariaLabel={f.label} className="w-full" value={value} onValueChange={onChange} options={f.options} disabled={disabled} />;
  } else if (f.kind === "bool") {
    control = <Segmented value={value === "true" ? "true" : "false"} options={[{ value: "true", label: f.on ?? "On" }, { value: "false", label: f.off ?? "Off" }]} onChange={(v) => onChange(v)} size="sm" className="w-full" />;
  } else if (f.kind === "int") {
    control = (
      <div className="flex items-center gap-2">
        <input id={inputId} className="input tabular-nums" type="number" inputMode="numeric" min={f.min ?? 0} max={f.max} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        {f.unit && <span className="w-16 shrink-0 text-xs text-ink3">{f.unit}</span>}
      </div>
    );
  } else {
    control = (
      <input
        id={inputId}
        className="input"
        type={f.kind === "secret" ? "password" : f.kind === "url" ? "url" : "text"}
        autoComplete={f.kind === "secret" ? "new-password" : "off"}
        placeholder={f.kind === "secret" ? (current ? `set (${String(current)}) · type to replace` : (f.placeholder ?? "not set")) : f.placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const sourceText = resetting ? `will go back to .env: ${describe(f, env[f.key])}` : fromDb ? `set here${s.updatedBy ? ` by ${s.updatedBy}` : ""} · .env has ${describe(f, env[f.key])}` : "from .env";

  return (
    <div className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-start">
      <div className="min-w-0">
        <label htmlFor={inputId} className="text-sm font-semibold">
          {f.label}
        </label>
        <p className="mt-0.5 text-xs leading-relaxed text-ink2">{help}</p>
        {ignored && (
          <Notice tone="warn" glyph="!" className="mt-2">
            {ignored}
          </Notice>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {control}
        <div className="flex min-h-5 items-baseline gap-2 text-xs text-ink3">
          <span className="min-w-0 flex-1 truncate" title={sourceText}>
            {sourceText}
          </span>
          {/* the slot is always there, so rows line up; it is empty when the value already comes from .env */}
          {fromDb && !resetting ? (
            <button type="button" className="btn-quiet h-5 shrink-0 px-1.5 py-0 text-xs" disabled={disabled} onClick={() => onChange(null)}>
              Back to .env
            </button>
          ) : resetting ? (
            <button type="button" className="btn-quiet h-5 shrink-0 px-1.5 py-0 text-xs" disabled={disabled} onClick={() => onChange(shown(f, current))}>
              Keep
            </button>
          ) : (
            <span className="h-5 shrink-0" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}
