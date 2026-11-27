/**
 * When a model in use stops being served, read from the providers' own model listings. Admins see it in
 * Settings → System → Models (beside each picker, and on the model rows), as a dot on the System tab, and as
 * a chip in the top bar; `check_model_retirements` (MCP), `reelsaw models retirements` and `reelsaw status`
 * return the same state, all from `createModelLifecycle`.
 *
 * Where the dates come from (each listing as the provider documents it, read 2026-11):
 *  - OpenAI `GET /v1/models`: `shutdown_date` ("YYYY-MM-DD", null until one is announced).
 *  - Anthropic `GET /v1/models`: `lifecycle` (active / deprecated / retired) and `retires_at` (RFC 3339, null
 *    while active or not scheduled; it can still move until the model retires).
 *  - OpenRouter, and any OpenAI-compatible router that copies it: `expiration_date` ("the date after which the
 *    model may be removed").
 *  - Vercel AI Gateway `GET /v1/models` (public): `deprecated_at`, milliseconds since the epoch. Not in its
 *    documentation; on whisper-1 it is OpenAI's own shutdown date (2027-02-26), so it is read as that. It is
 *    set on few models: the gateway can serve a model the vendor is retiring with no date at all.
 *  - Google, Groq, Deepgram, AssemblyAI, OpenCode and self-hosted servers publish nothing: a model there shows
 *    as "no dates published", never as safe.
 * A provider that names a replacement in its listing has it shown; none of the four above does today, so the
 * replacement field stays empty rather than guessed.
 */
import { formatDay } from "@reelsaw/shared";
import { msg, plural } from "@lingui/core/runtime-macro";
import { t } from "../i18n.js";
import type { CatalogKind, CatalogProvider, ModelCatalog } from "./catalog.js";
import type { ModelIds } from "./models.js";

/** What a provider's listing says about a model going away. Absent on a model the listing says nothing about. */
export interface ModelRetirement {
  /** ISO timestamp when the provider stops serving it; null when it is deprecated with no date yet */
  retiresAt: string | null;
  /** the model the provider points to instead, when its listing names one */
  replacement: string | null;
}

/** Inside this many days a retirement is urgent (the chip turns red). */
const RETIREMENT_SOON_DAYS = 30;
const DAY_MS = 86_400_000;

type RetirementStatus =
  /** the date has passed: calls may already fail */
  | { status: "retired"; daysLeft: 0 }
  /** within RETIREMENT_SOON_DAYS */
  | { status: "soon"; daysLeft: number }
  | { status: "scheduled"; daysLeft: number }
  /** deprecated, no date announced */
  | { status: "deprecated"; daysLeft: null };

/** How urgent a retirement is at `now` (ms). Whole days, rounded up: a model retiring later today has 1 day left. */
export function retirementStatus(r: ModelRetirement, now: number): RetirementStatus {
  if (!r.retiresAt) return { status: "deprecated", daysLeft: null };
  const at = Date.parse(r.retiresAt);
  if (!Number.isFinite(at)) return { status: "deprecated", daysLeft: null };
  if (at <= now) return { status: "retired", daysLeft: 0 };
  const daysLeft = Math.ceil((at - now) / DAY_MS);
  return daysLeft <= RETIREMENT_SOON_DAYS ? { status: "soon", daysLeft } : { status: "scheduled", daysLeft };
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v !== "string" || !v.trim()) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const field = (entry: unknown, key: string): unknown => (entry && typeof entry === "object" ? Reflect.get(entry, key) : undefined);

/** OpenAI `/v1/models` entry: `shutdown_date`. */
export function openAiRetirement(entry: unknown): ModelRetirement | undefined {
  const at = isoOrNull(field(entry, "shutdown_date"));
  return at ? { retiresAt: at, replacement: null } : undefined;
}

/** Anthropic `/v1/models` entry: `lifecycle` plus `retires_at`. A deprecated model with no date yet still counts. */
export function anthropicRetirement(entry: unknown): ModelRetirement | undefined {
  const lifecycle = field(entry, "lifecycle");
  const at = isoOrNull(field(entry, "retires_at"));
  if (lifecycle !== "deprecated" && lifecycle !== "retired" && !at) return undefined;
  return { retiresAt: at, replacement: null };
}

/** OpenRouter-style `expiration_date` on an OpenAI-compatible `/models` entry. */
export function expirationRetirement(entry: unknown): ModelRetirement | undefined {
  const at = isoOrNull(field(entry, "expiration_date"));
  return at ? { retiresAt: at, replacement: null } : undefined;
}

/** Vercel AI Gateway public `/v1/models` entry: `deprecated_at` (ms; see the header). */
export function gatewayRetirement(entry: unknown): ModelRetirement | undefined {
  const at = isoOrNull(field(entry, "deprecated_at"));
  return at ? { retiresAt: at, replacement: null } : undefined;
}

/** Does a compatible server's listing carry retirement dates at all (OpenRouter always sends the key, often null)? */
export function listsExpiration(entries: readonly unknown[]): boolean {
  return entries.some((e) => e !== null && typeof e === "object" && "expiration_date" in e);
}

type ModelUse = keyof ModelIds | "judge";

interface ModelInUse {
  /** provider:model, as configured */
  model: string;
  /** what it is used for here (one id can do several jobs) */
  uses: ModelUse[];
  /** the provider's name as the picker shows it */
  providerTitle: string;
  /** what the provider's listing says; null when it says nothing about this model */
  retirement: (ModelRetirement & RetirementStatus) | null;
  /** the provider's listing carries retirement dates; false = nothing can be known from here */
  published: boolean;
  /** the provider could not be listed just now, so its dates are unknown this time */
  error: string | null;
}

export interface ModelLifecycle {
  checkedAt: string;
  /** every model in use, soonest retirement first */
  models: ModelInUse[];
  /** how many models in use are retiring (any status), the count the dot and the chip show */
  retiring: number;
  /** the most urgent status among them, null when none is retiring */
  worst: RetirementStatus["status"] | null;
}

const ORDER: Record<RetirementStatus["status"], number> = { retired: 0, soon: 1, scheduled: 2, deprecated: 3 };

/** Find `id` in one kind's listing: the provider whose prefix it carries, then the model with that exact id. */
function lookup(listing: readonly CatalogProvider[], id: string) {
  const prefix = id.slice(0, Math.max(0, id.indexOf(":")));
  const provider = listing.find((p) => p.provider === prefix || p.prefixes?.includes(prefix));
  return { provider, model: provider?.models.find((m) => m.id === id) };
}

/**
 * The models in use and what their providers say about retiring them, decided from plain data (the listings
 * and `now`), so it is tested without a network.
 */
export function lifecycleOf(
  inUse: ReadonlyArray<{ model: string; use: ModelUse; kind: CatalogKind }>,
  listings: Record<CatalogKind, readonly CatalogProvider[]>,
  now: number,
): ModelLifecycle {
  const byModel = new Map<string, ModelInUse>();
  for (const { model, use, kind } of inUse) {
    const seen = byModel.get(model);
    if (seen) {
      if (!seen.uses.includes(use)) seen.uses.push(use);
      continue;
    }
    const { provider, model: listed } = lookup(listings[kind], model);
    const r = listed?.retirement;
    byModel.set(model, {
      model,
      uses: [use],
      providerTitle: provider?.title ?? model.split(":")[0] ?? model,
      retirement: r ? { ...r, ...retirementStatus(r, now) } : null,
      published: provider?.lifecycle === true,
      error: provider?.error ?? null,
    });
  }
  const models = [...byModel.values()].sort(
    (a, b) =>
      (a.retirement ? ORDER[a.retirement.status] : 9) - (b.retirement ? ORDER[b.retirement.status] : 9) ||
      (a.retirement?.retiresAt ?? "").localeCompare(b.retirement?.retiresAt ?? ""),
  );
  const retiring = models.filter((m) => m.retirement);
  return { checkedAt: new Date(now).toISOString(), models, retiring: retiring.length, worst: retiring[0]?.retirement?.status ?? null };
}

/** One model in use in a sentence, for the CLI: "retires Jan 14, 2027 (in 48 days)", "no dates published by Google". */
export function describeModelInUse(m: ModelInUse): string {
  const provider = m.providerTitle;
  if (m.error) return t(msg`unknown: ${{ provider }} could not be listed (${{ error: m.error }})`);
  const r = m.retirement;
  if (!r) return m.published ? t(msg`no retirement announced`) : t(msg`no dates published by ${{ provider }}`);
  // providers give a UTC day ("2027-01-14"): shown as that day for every reader
  const date = r.retiresAt ? formatDay(r.retiresAt, { utc: true }) : "";
  const instead = r.replacement ? t(msg`; ${{ provider }} suggests ${{ replacement: r.replacement }}`) : "";
  switch (r.status) {
    case "retired":
      return t(msg`RETIRED on ${{ date }}: calls may already fail${{ instead }}`);
    case "soon":
    case "scheduled":
      return t(msg`retires ${{ date }} (${plural({ days: r.daysLeft }, { one: "in # day", other: "in # days" })})${{ instead }}`);
    case "deprecated":
      return t(msg`deprecated, no retirement date yet${{ instead }}`);
  }
}

/** Listings are asked again after this long (a retirement date moves rarely; the top bar asks on every admin page). */
export const LIFECYCLE_CACHE_MS = 6 * 3600_000;
/** ...and after this long when a provider's listing failed. */
const LIFECYCLE_RETRY_MS = 5 * 60_000;

export interface ModelLifecycleChecker {
  /** The models in use with their retirements; listings are re-read after LIFECYCLE_CACHE_MS, or now with `refresh`. */
  get(opts?: { refresh?: boolean | undefined }): Promise<ModelLifecycle>;
}

export function createModelLifecycle(deps: {
  catalog: Pick<ModelCatalog, "list">;
  models: { get(): ModelIds };
  /** ANALYZE_JUDGE_MODEL, when set */
  judge?: string | undefined;
  now?: () => number;
}): ModelLifecycleChecker {
  const now = deps.now ?? Date.now;
  let cached: { key: string; at: number; ttl: number; value: ModelLifecycle } | null = null;
  let inflight: { key: string; value: Promise<ModelLifecycle> } | null = null;
  return {
    async get({ refresh = false } = {}) {
      const m = deps.models.get();
      const inUse: Array<{ model: string; use: ModelUse; kind: CatalogKind }> = [
        { model: m.language, use: "language", kind: "language" },
        { model: m.transcription, use: "transcription", kind: "transcription" },
        { model: m.align, use: "align", kind: "transcription" },
      ];
      if (deps.judge) inUse.push({ model: deps.judge, use: "judge", kind: "language" });
      // a model change in Settings is a new key, so it is looked up at once rather than after the cache runs out
      const key = inUse.map((u) => `${u.use}=${u.model}`).join(",");
      if (!refresh && cached?.key === key && now() - cached.at < cached.ttl) return cached.value;
      if (inflight?.key === key) return inflight.value;
      const value = (async () => {
        const [language, transcription] = await Promise.all([deps.catalog.list("language", { refresh }), deps.catalog.list("transcription", { refresh })]);
        const v = lifecycleOf(inUse, { language, transcription }, now());
        // a provider that could not be listed is asked again on the catalog's own schedule, not hours later
        cached = { key, at: now(), ttl: v.models.some((u) => u.error) ? LIFECYCLE_RETRY_MS : LIFECYCLE_CACHE_MS, value: v };
        return v;
      })().finally(() => {
        inflight = null;
      });
      inflight = { key, value };
      return value;
    },
  };
}
