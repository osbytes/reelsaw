import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC } from "../lib/trpc";
import { ago } from "../lib/time";
import { PANEL_FOCUS_CLEARANCE, StickyPanelFooter } from "./StickyPanelFooter";
import { ConfirmDialog, Notice, Segmented, Select, Skeleton, SkeletonRegion } from "./ui";

type State = inferRouterOutputs<AppRouter>["admin"]["settings"]["get"];
type Patch = inferRouterInputs<AppRouter>["admin"]["settings"]["set"];
type Key = keyof State["values"];

/** Copy for a field: a catalogue message (module-level lists) or a string already in the active locale. */
type FieldText = string | MessageDescriptor;
/** The field copy in the active locale. */
const txt = (x: FieldText): string => (typeof x === "string" ? x : i18n._(x));

/** How one setting is edited. Help text and validation come from the server (one registry); this is only the control. */
export type Field =
  | { key: Key; label: FieldText; kind: "enum"; options: Array<{ value: string; label: FieldText }> }
  | { key: Key; label: FieldText; kind: "bool"; on?: FieldText; off?: FieldText }
  | { key: Key; label: FieldText; kind: "int"; min?: number; max?: number; unit?: FieldText; zero?: FieldText }
  | { key: Key; label: FieldText; kind: "url" | "text" | "secret"; placeholder?: FieldText };

/** A retention setting's risky direction: keeping less, which the next sweep acts on. 0 is forever. */
const shorter = (what: MessageDescriptor) => (to: unknown, from: unknown) => {
  if (!(Number(to) > 0 && (Number(from) === 0 || Number(to) < Number(from)))) return null;
  const items = i18n._(what);
  const days = Number(to);
  return t`${items} older than ${days} days are removed for good on the next sweep.`;
};

/**
 * What a change does when it is one to ask about (PRINCIPLES: "Confirm risky changes"), or null. Only
 * the risky direction asks: tightening sign-ups or keeping data longer just saves.
 */
const RISK: Partial<Record<Key, (to: unknown, from: unknown) => string | null>> = {
  SIGNUP_MODE: (to) =>
    to === "open" ? t`Anyone can create an account and use this instance without approval.` : to === "closed" ? t`Nobody new can sign up.` : null,
  REQUIRE_EMAIL_VERIFICATION: (to) => (to === false ? t`New accounts no longer have to verify their email.` : null),
  BLOCK_DISPOSABLE_EMAILS: (to) => (to === false ? t`Temporary email domains can sign up.` : null),
  CAPTCHA_PROVIDER: (to) => (to === "" ? t`Sign-ups no longer need a captcha.` : null),
  ALLOW_PRIVATE_SOURCE_URLS: (to) => (to === true ? t`Project links can reach private networks from this server.` : null),
  ALLOW_PRIVATE_WEBHOOK_URLS: (to) => (to === true ? t`Webhooks can reach private networks from this server.` : null),
  SOURCE_RETENTION_DAYS: shorter(msg`Source videos`),
  CLIP_RETENTION_DAYS: shorter(msg`Rendered clips`),
  DELETED_RETENTION_DAYS: shorter(msg`Deleted items`),
  EVENT_RETENTION_DAYS: shorter(msg`Project events`),
  LLM_USAGE_RETENTION_DAYS: shorter(msg`Usage rows`),
  ADMIN_EVENT_RETENTION_DAYS: shorter(msg`Admin log entries`),
  DECISION_RETENTION_DAYS: shorter(msg`Users’ decisions`),
};

export const ACCESS_FIELDS: Field[] = [
  {
    key: "SIGNUP_MODE",
    label: msg`Sign-ups`,
    kind: "enum",
    options: [
      { value: "open", label: msg`Open` },
      { value: "approval", label: msg`Approval` },
      { value: "closed", label: msg`Closed` },
    ],
  },
  { key: "REQUIRE_EMAIL_VERIFICATION", label: msg`Email verification`, kind: "bool", on: msg`Required`, off: msg`Off` },
  { key: "MAX_SIGNUPS_PER_IP_PER_DAY", label: msg`Sign-ups per address per day`, kind: "int", unit: msg`accounts`, zero: msg`unlimited` },
  { key: "BLOCK_DISPOSABLE_EMAILS", label: msg`Temporary email domains`, kind: "bool", on: msg`Refused`, off: msg`Allowed` },
  {
    key: "CAPTCHA_PROVIDER",
    label: msg`Captcha`,
    kind: "enum",
    options: [
      { value: "", label: msg`Off` },
      { value: "cloudflare-turnstile", label: "Cloudflare Turnstile" },
      { value: "google-recaptcha", label: "Google reCAPTCHA" },
      { value: "hcaptcha", label: "hCaptcha" },
    ],
  },
  { key: "CAPTCHA_SITE_KEY", label: msg`Captcha site key`, kind: "text", placeholder: msg`public key` },
  { key: "CAPTCHA_SECRET_KEY", label: msg`Captcha secret key`, kind: "secret", placeholder: msg`not set` },
  { key: "TERMS_URL", label: msg`Terms of service link`, kind: "url", placeholder: msg`https://… (none)` },
  { key: "PRIVACY_URL", label: msg`Privacy policy link`, kind: "url", placeholder: msg`https://… (none)` },
];

export const LIMIT_FIELDS: Field[] = [
  { key: "MAX_PROJECTS_PER_USER", label: msg`Projects kept`, kind: "int", unit: msg`projects`, zero: msg`unlimited` },
  { key: "MAX_SOURCE_MINUTES_PER_DAY", label: msg`Minutes of video per day`, kind: "int", unit: msg`minutes`, zero: msg`unlimited` },
  { key: "MAX_NEW_PROJECTS_PER_HOUR", label: msg`New projects per hour`, kind: "int", unit: msg`projects`, zero: msg`unlimited` },
  { key: "MAX_LIVE_JOBS_PER_USER", label: msg`Jobs at once`, kind: "int", unit: msg`jobs`, zero: msg`unlimited` },
  { key: "MAX_RERENDERS_PER_HOUR", label: msg`Renders asked for per hour`, kind: "int", unit: msg`renders`, zero: msg`unlimited` },
  { key: "MAX_MANUAL_CLIPS_PER_USER", label: msg`Clips made by hand`, kind: "int", unit: msg`clips`, zero: msg`unlimited` },
  { key: "MAX_SOURCE_MINUTES_PER_MONTH", label: msg`Minutes of video per month`, kind: "int", unit: msg`minutes`, zero: msg`unlimited` },
  { key: "MAX_STORAGE_MB", label: msg`Storage per account`, kind: "int", unit: "MB", zero: msg`unlimited` },
  { key: "WATERMARK_NON_ADMINS", label: msg`Watermark for non-admins`, kind: "bool", on: msg`On`, off: msg`Off` },
  { key: "WATERMARK_TEXT", label: msg`Watermark text`, kind: "text", placeholder: msg`none: the logo alone` },
  { key: "MAX_REQUESTS_PER_MINUTE", label: msg`Changes per minute`, kind: "int", unit: msg`requests`, zero: msg`unlimited` },
  { key: "MAX_REQUESTS_PER_HOUR", label: msg`Changes per hour`, kind: "int", unit: msg`requests`, zero: msg`unlimited` },
  { key: "MAX_UPLOAD_MB", label: msg`Largest upload`, kind: "int", min: 1, unit: "MB" },
  { key: "MAX_SOURCE_FILE_MB", label: msg`Largest link download`, kind: "int", min: 1, unit: "MB" },
  { key: "ALLOW_PRIVATE_SOURCE_URLS", label: msg`Links to private networks`, kind: "bool", on: msg`Allowed`, off: msg`Blocked` },
  { key: "MAX_WEBHOOKS_PER_USER", label: msg`Webhooks per account`, kind: "int", unit: msg`webhooks`, zero: msg`unlimited` },
  { key: "ALLOW_PRIVATE_WEBHOOK_URLS", label: msg`Webhooks to private networks`, kind: "bool", on: msg`Allowed`, off: msg`Blocked` },
  { key: "MEDIA_LINK_TTL_DAYS", label: msg`Share links last`, kind: "int", min: 1, unit: msg`days` },
  { key: "MEDIA_LINK_ALLOW_NEVER", label: msg`Share links that never expire`, kind: "bool", on: msg`Allowed`, off: msg`Not allowed` },
];

export const RETENTION_FIELDS: Field[] = [
  { key: "SOURCE_RETENTION_DAYS", label: msg`Keep source videos`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "CLIP_RETENTION_DAYS", label: msg`Keep rendered clips`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "DELETED_RETENTION_DAYS", label: msg`Keep deleted items restorable`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "SCRATCH_CACHE_HOURS", label: msg`Keep worker copies of stored files`, kind: "int", unit: msg`idle hours`, zero: msg`forever` },
  { key: "EVENT_RETENTION_DAYS", label: msg`Keep project events`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "LLM_USAGE_RETENTION_DAYS", label: msg`Keep usage rows`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "ADMIN_EVENT_RETENTION_DAYS", label: msg`Keep the admin log`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "DECISION_RETENTION_DAYS", label: msg`Keep users' decisions`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "MEDIA_LINK_RETENTION_DAYS", label: msg`Keep revoked share links listed`, kind: "int", unit: msg`days`, zero: msg`forever` },
  { key: "WEBHOOK_DELIVERY_RETENTION_DAYS", label: msg`Keep webhook delivery logs`, kind: "int", unit: msg`days`, zero: msg`forever` },
];

export const PIPELINE_FIELDS: Field[] = [
  { key: "TRANSCRIPT_CORRECTION", label: msg`Name fixes after transcription`, kind: "bool", on: msg`On`, off: msg`Off` },
  { key: "DISFLUENCY_REMOVAL", label: msg`Filler and repeat removal`, kind: "bool", on: msg`On`, off: msg`Off` },
  { key: "DISFLUENCY_LLM", label: msg`Model pass for fillers`, kind: "bool", on: msg`On`, off: msg`Rules only` },
  { key: "REFINE_SCENES", label: msg`On-screen text scan`, kind: "bool", on: msg`On`, off: msg`Off` },
];

export const OPERATIONS_FIELDS: Field[] = [
  { key: "STALL_MINUTES", label: msg`Stall watchdog`, kind: "int", min: 2, max: 1440, unit: msg`minutes` },
  { key: "EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES", label: msg`Ready email delay`, kind: "int", min: 1, max: 180, unit: msg`minutes` },
  { key: "UPDATE_CHECK", label: msg`Update check`, kind: "bool", on: msg`On`, off: msg`Off` },
  { key: "HEALTH_DETAILS", label: msg`Machine numbers in /api/health`, kind: "bool", on: msg`Anyone`, off: msg`Admins only` },
];

export const LIBRARY_FIELDS: Field[] = [
  { key: "CATALOG_URL", label: msg`Reelsaw catalog URL`, kind: "url", placeholder: "https://reelsaw.com/catalog/v1/index.json" },
  { key: "PEXELS_API_KEY", label: msg`Pexels key`, kind: "secret", placeholder: msg`not set` },
  { key: "PIXABAY_API_KEY", label: msg`Pixabay key`, kind: "secret", placeholder: msg`not set` },
  { key: "FREESOUND_API_KEY", label: msg`Freesound key`, kind: "secret", placeholder: msg`not set` },
  { key: "GIPHY_API_KEY", label: msg`Giphy key`, kind: "secret", placeholder: msg`not set` },
  { key: "KLIPY_API_KEY", label: msg`Klipy key (beta)`, kind: "secret", placeholder: msg`not set` },
  { key: "ICONIFY_API_URL", label: msg`Iconify API`, kind: "url", placeholder: "https://api.iconify.design" },
  { key: "OPENVERSE_ENABLED", label: msg`Openverse`, kind: "bool", on: msg`Shown`, off: msg`Hidden` },
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
  if (f.kind === "bool") return v ? txt(f.on ?? msg`On`) : txt(f.off ?? msg`Off`);
  if (f.kind === "enum") {
    const o = f.options.find((x) => x.value === (v ?? ""));
    return o ? txt(o.label) : v === null || v === undefined ? t`none` : String(v);
  }
  if (f.kind === "int") return v === 0 && f.zero ? txt(f.zero) : `${v}${f.unit ? ` ${txt(f.unit)}` : ""}`;
  if (f.kind === "secret") {
    const tail = String(v ?? "");
    return v ? t`set (${tail})` : t`not set`;
  }
  return v ? String(v) : t`none`;
};

/**
 * One group of runtime instance settings (Settings → System → Access / Limits / Retention / Operations).
 * Each row: the label and the server's help on the left, the control on the right with where the value
 * comes from (.env or set here) and a way back to .env. Changes are drafted per group and saved together,
 * because the server validates the result as a whole (a captcha needs both keys).
 */
export function InstanceSettingsGroup({
  id,
  title,
  intro,
  fields,
  children,
}: {
  id: string;
  title: string;
  intro: string;
  fields: Field[];
  children?: ReactNode;
}) {
  const { t: tr } = useLingui();
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
        const names = fields
          .filter((f) => f.key in input)
          .map((f) => txt(f.label))
          .join(", ");
        toast(tr`Saved: ${names}. Every process applies it within a few seconds`);
        void qc.invalidateQueries({ queryKey: trpc.admin.settings.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.admin.system.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.system.status.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.admin.updates.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.library.pathKey() }); // Browse lists providers by their keys
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
          const label = txt(f.label);
          const lo = f.min ?? 0;
          const hi = f.max ?? "∞";
          problem ??=
            f.min !== undefined || f.max !== undefined ? t`${label}: enter a whole number between ${lo} and ${hi}` : t`${label}: enter a whole number`;
          continue;
        }
        patch[f.key] = n;
      } else if (f.kind === "bool") patch[f.key] = d === "true";
      else patch[f.key] = d;
    }
    return { patch: patch as Patch, problem };
  }, [draft, fields]);
  const dirty = Object.keys(patch).length > 0;
  const [asking, setAsking] = useState(false);
  const risks = riskyEffects(s, patch);
  const lowerTitle = title.toLowerCase();
  const lastAgo = s?.updatedAt ? ago(s.updatedAt) : "";
  const lastBy = s?.updatedBy;

  return (
    <section id={id} className={`flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5 ${PANEL_FOCUS_CLEARANCE}`}>
      <div>
        <h2 className="text-[15px] font-bold">{title}</h2>
        <p className="mt-0.5 text-sm text-ink2">{intro}</p>
      </div>
      {!s ? (
        <SkeletonRegion label={tr`Loading ${lowerTitle}…`} className="flex flex-col divide-y divide-line">
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
            <FieldRow
              key={f.key}
              field={f}
              state={s}
              draft={draft[f.key]}
              onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
              disabled={save.isPending}
            />
          ))}
        </div>
      )}
      {children}
      {/* always-present footer, so saving never shifts the rows above */}
      <StickyPanelFooter>
        <span className="me-auto min-h-5 text-xs text-ink3">
          {problem ?? (s?.updatedAt ? (lastBy ? tr`Last change ${lastAgo} by ${lastBy}` : tr`Last change ${lastAgo}`) : "")}
        </span>
        <button type="button" className="btn-quiet" disabled={!dirty || save.isPending} onClick={() => setDraft({})}>
          <Trans>Discard</Trans>
        </button>
        <button
          type="button"
          className="btn-primary min-w-[6.5rem]"
          disabled={!dirty || !!problem || save.isPending}
          onClick={() => (risks.length ? setAsking(true) : save.mutate(patch))}
        >
          {save.isPending ? tr`Saving…` : tr`Save`}
        </button>
      </StickyPanelFooter>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={tr`Save this for every account?`}
        body={tr`It applies across the instance within seconds.`}
        confirm={tr`Save`}
        danger
        onConfirm={() => save.mutateAsync(patch)}
      >
        <ul className="list-disc ps-5 text-sm leading-relaxed text-ink2">
          {risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </section>
  );
}

/** The consequences to ask about in a patch; null in a patch means back to the environment's value. */
function riskyEffects(s: State | undefined, patch: Patch): string[] {
  if (!s) return [];
  const values = s.values as Record<string, unknown>;
  const env = s.env as Record<string, unknown>;
  return Object.entries(patch).flatMap(([key, v]) => {
    const r = RISK[key as Key]?.(v === null ? env[key] : v, values[key]);
    return r ? [r] : [];
  });
}

function FieldRow({
  field: f,
  state: s,
  draft,
  onChange,
  disabled,
}: {
  field: Field;
  state: State;
  draft: string | null | undefined;
  onChange: (v: string | null) => void;
  disabled: boolean;
}) {
  const { t: tr } = useLingui();
  const label = txt(f.label);
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
  const currentText = String(current ?? "");

  let control: ReactNode;
  if (f.kind === "enum" && f.options.length <= 3) {
    control = (
      <Segmented
        value={value}
        options={f.options.map((o) => ({ value: o.value, label: txt(o.label) }))}
        onChange={(v) => onChange(v)}
        size="sm"
        className="w-full"
      />
    );
  } else if (f.kind === "enum") {
    control = (
      <Select
        ariaLabel={label}
        className="w-full"
        value={value}
        onValueChange={onChange}
        options={f.options.map((o) => ({ value: o.value, label: txt(o.label) }))}
        disabled={disabled}
      />
    );
  } else if (f.kind === "bool") {
    control = (
      <Segmented
        value={value === "true" ? "true" : "false"}
        options={[
          { value: "true", label: txt(f.on ?? msg`On`) },
          { value: "false", label: txt(f.off ?? msg`Off`) },
        ]}
        onChange={(v) => onChange(v)}
        size="sm"
        className="w-full"
      />
    );
  } else if (f.kind === "int") {
    control = (
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          className="input tabular-nums"
          type="number"
          inputMode="numeric"
          min={f.min ?? 0}
          max={f.max}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        {f.unit && <span className="w-16 shrink-0 text-xs text-ink3">{txt(f.unit)}</span>}
      </div>
    );
  } else {
    control = (
      <input
        id={inputId}
        className="input"
        type={f.kind === "secret" ? "password" : f.kind === "url" ? "url" : "text"}
        autoComplete={f.kind === "secret" ? "new-password" : "off"}
        placeholder={
          f.kind === "secret"
            ? current
              ? tr`set (${currentText}) · type to replace`
              : txt(f.placeholder ?? msg`not set`)
            : f.placeholder === undefined
              ? undefined
              : txt(f.placeholder)
        }
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const envText = describe(f, env[f.key]);
  const by = s.updatedBy;
  const sourceText = resetting
    ? tr`will go back to .env: ${envText}`
    : fromDb
      ? by
        ? tr`set here by ${by} · .env has ${envText}`
        : tr`set here · .env has ${envText}`
      : tr`from .env`;

  return (
    <div className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-start">
      <div className="min-w-0">
        <label htmlFor={inputId} className="text-sm font-semibold">
          {label}
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
              <Trans>Back to .env</Trans>
            </button>
          ) : resetting ? (
            <button type="button" className="btn-quiet h-5 shrink-0 px-1.5 py-0 text-xs" disabled={disabled} onClick={() => onChange(shown(f, current))}>
              <Trans>Keep</Trans>
            </button>
          ) : (
            <span className="h-5 shrink-0" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}
