/**
 * Quotas: one precedence chain per number (README, "Settings and precedence"): the environment, then the
 * admin's runtime override (instance-settings.ts), then what the account's plan grants (`Entitlements`,
 * provided by ee/ on a hosted instance; null self-hosted), then an admin's per-user override
 * (`user_settings.limits`). 0 = unlimited. Refusals are sentences the user can act on, with the plan's
 * upgrade hint when there is one. Checked where the number is known: project count and rate at creation,
 * source minutes at creation when the link announces its length and bound once ffprobe has run, storage at upload. The watermark follows the same chain.
 */
import { and, eq, gte, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { deletedProjectsPath, type QuotaAction, type QuotaRefusal, formatDay, formatMb, plural } from "@reelsaw/shared";
import { schema, type Db } from "./db/index.js";
import type { RuntimeSettings } from "./instance-settings.js";
import type { Admission } from "./queue/boss.js";
import type { UserRole } from "./db/schema.js";
import { takeTxLock, txLock } from "./locks.js";
import { NonRetryableError } from "./pipeline/common.js";
import type { Telemetry } from "./telemetry.js";

export const LIMIT_KEYS = [
  "MAX_PROJECTS_PER_USER",
  "MAX_SOURCE_MINUTES_PER_DAY",
  "MAX_SOURCE_MINUTES_PER_MONTH",
  "MAX_NEW_PROJECTS_PER_HOUR",
  "MAX_LIVE_JOBS_PER_USER",
  "MAX_RERENDERS_PER_HOUR",
  "MAX_STORAGE_MB",
  "MAX_REQUESTS_PER_MINUTE",
  "MAX_REQUESTS_PER_HOUR",
  "MAX_WEBHOOKS_PER_USER",
  "MAX_MANUAL_CLIPS_PER_USER",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Record<LimitKey, number>;
/** The instance-wide numbers in force (`svc.settings.get()`): the environment, or the admin's runtime override. */
export type InstanceLimits = Pick<RuntimeSettings, LimitKey | "WATERMARK_NON_ADMINS" | "WATERMARK_TEXT">;

/** What an account's plan grants (ee/billing/entitlements.ts). `null` for a key = the plan says nothing about it. */
export interface Grants {
  plan: string;
  planLabel: string;
  limits: Partial<Limits>;
  /** false = the plan removes the watermark; null = the plan says nothing */
  watermark: boolean | null;
  /** the account's first video is free of the monthly count when it is at most this long (0 = none) */
  firstVideoFreeMinutes?: number;
  /** added to the fair-share priority of the account's jobs (0 = none) */
  queuePriority?: number;
  /** a link's source is downloaded at most this tall, clips render from full-quality windows (null/absent = full download) */
  sourceHeight?: number | null;
  /** the most cores and memory the account's leases may hold at once (resources.ts `claimOnLive`); absent = no account ceiling */
  resources?: ResourceCeiling | null;
  /** the account's leases may not take the last this many cores of a machine (hosted Free: FREE_RESERVE_CORES); absent = 0 */
  reserveCores?: number;
  /** the billing period, when the account has one; monthly allowances count inside it */
  period: { start: Date; end: Date } | null;
  /** appended to a refusal: "Pro gives 1,200 minutes a month" and where to go; `plan`/`limits` drive the upgrade CTA */
  upgrade?: {
    text: string;
    url: string;
    plan: string;
    planLabel: string;
    limits: Partial<Limits>;
    /** USD a month on monthly billing, for buttons that name the cost */
    monthlyPrice?: number | undefined;
    /** false = that plan renders without the watermark (the "Remove watermark" offer) */
    watermark?: boolean | null | undefined;
    /** that plan's source cap; null = it downloads links at full quality (the "full-quality video" offer) */
    sourceHeight?: number | null | undefined;
  };
}
export interface Entitlements {
  /** Read at the point of use, inside the caller's transaction when it has one. Never cached across requests. */
  grantsFor(db: Db, userId: string): Promise<Grants | null>;
}

export type LimitSource = "instance" | "plan" | "override";
export interface LimitsDetail {
  limits: Limits;
  source: Record<LimitKey, LimitSource>;
  plan: string | null;
  grants: Grants | null;
}

/** The numbers in force for one account, with where each came from. One read of the override row and one of the plan. */
export async function limitsDetail(db: Db, instance: InstanceLimits, userId: string, ent?: Entitlements | null): Promise<LimitsDetail> {
  const [row, grants] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId), columns: { limits: true } }),
    ent ? ent.grantsFor(db, userId) : null,
  ]);
  const limits = {} as Limits;
  const source = {} as Record<LimitKey, LimitSource>;
  for (const k of LIMIT_KEYS) {
    const o = row?.limits?.[k];
    const g = grants?.limits[k];
    if (typeof o === "number" && o >= 0) [limits[k], source[k]] = [o, "override"];
    else if (typeof g === "number" && g >= 0) [limits[k], source[k]] = [g, "plan"];
    else [limits[k], source[k]] = [instance[k], "instance"];
  }
  return { limits, source, plan: grants?.plan ?? null, grants };
}

export async function limitsFor(db: Db, instance: InstanceLimits, userId: string, ent?: Entitlements | null): Promise<Limits> {
  return (await limitsDetail(db, instance, userId, ent)).limits;
}

export type QueuePrioritySource = "instance" | "plan" | "override";
export interface QueuePriority {
  /** points added to each of the account's jobs' fair-share priority (queue/boss.ts `fairPriority`) */
  value: number;
  source: QueuePrioritySource;
  /** what the plan grants (0 without one), shown beside an override */
  plan: number;
  /** the admin's override; null = follow the plan */
  override: number | null;
}

/**
 * The account's queue priority: an admin's per-user override, else what the plan grants (hosted: paid plans rank
 * ahead of Free), else 0. Read at enqueue in the caller's transaction (uow.ts), so a change applies to the next job;
 * jobs already queued keep their place.
 */
export async function queuePriorityFor(db: Db, userId: string, ent?: Entitlements | null): Promise<QueuePriority> {
  const [row, grants] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId), columns: { queuePriority: true } }),
    ent ? ent.grantsFor(db, userId) : null,
  ]);
  return queuePriorityOf(row?.queuePriority ?? null, grants);
}

export function queuePriorityOf(override: number | null, grants: Grants | null): QueuePriority {
  const plan = grants?.queuePriority ?? 0;
  if (typeof override === "number") return { value: override, source: "override", plan, override };
  return { value: plan, source: plan ? "plan" : "instance", plan, override: null };
}

/** The most cores and MB of memory one account's leases may hold at once, across every machine (docs/specs/resource-leases.md). */
export interface ResourceCeiling {
  maxCores: number;
  maxMemMB: number;
}

interface AccountResources {
  /** the ceiling in force; null = none (self-hosted, or a plan that sets none) */
  value: ResourceCeiling | null;
  source: QueuePrioritySource;
  /** what the plan grants (null without one), shown beside an override */
  plan: ResourceCeiling | null;
  /** the admin's override; null = follow the plan */
  override: ResourceCeiling | null;
  /** cores of a machine the account's leases leave free (hosted Free: FREE_RESERVE_CORES) */
  reserveCores: number;
}

/**
 * The account's resource ceiling: an admin's per-user override, else what the plan grants, else none. Read in the
 * lease step (resource-leases.ts `createLeaser`), so a change applies to the next claim; leases already out keep theirs.
 */
export async function resourceCeilingFor(db: Db, userId: string, ent?: Entitlements | null): Promise<AccountResources> {
  const [row, grants] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId), columns: { resources: true } }),
    ent ? ent.grantsFor(db, userId) : null,
  ]);
  return resourceCeilingOf(row?.resources ?? null, grants);
}

export function resourceCeilingOf(override: ResourceCeiling | null, grants: Grants | null): AccountResources {
  const plan = grants?.resources ?? null;
  const reserveCores = Math.max(0, grants?.reserveCores ?? 0);
  if (override) return { value: override, source: "override", plan, override, reserveCores };
  return { value: plan, source: plan ? "plan" : "instance", plan, override: null, reserveCores };
}

/**
 * How tall a link's source is downloaded for this account: the plan's cap (Free: 240p, the editor's and analysis's
 * copy; clips still render from full-quality windows, pipeline/sections.ts), or null for the full download.
 * Admins and instances without plans always get the full download.
 */
export async function sourceHeightFor(db: Db, userId: string, ent?: Entitlements | null): Promise<number | null> {
  if (!ent) return null;
  const [owner, grants] = await Promise.all([
    db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { role: true } }),
    ent.grantsFor(db, userId),
  ]);
  return sourceHeightOf(owner?.role, grants);
}

/** The cap from what is already read: admins and accounts without a plan get the full download. */
function sourceHeightOf(role: UserRole | undefined, grants: Grants | null): number | null {
  if (role === "admin") return null;
  const h = grants?.sourceHeight;
  return typeof h === "number" && h > 0 ? h : null;
}

/**
 * The source quality this account's links get, and the plan that gives full quality: what the project page and the
 * editor show on a preview-sized video. `upgrade` only when the next plan lifts the cap.
 */
export async function sourceQualityFor(
  db: Db,
  user: { id: string; role: UserRole },
  ent?: Entitlements | null,
): Promise<{ height: number | null; upgrade?: { label: string; href: string } }> {
  if (!ent || user.role === "admin") return { height: null };
  const grants = await ent.grantsFor(db, user.id);
  const height = sourceHeightOf(user.role, grants);
  if (!height) return { height };
  const u = grants?.upgrade;
  if (!u || (typeof u.sourceHeight === "number" && u.sourceHeight > 0)) return { height };
  const label = u.monthlyPrice
    ? `${u.planLabel}: full-quality video for $${u.monthlyPrice.toLocaleString("en-US")} a month`
    : `${u.planLabel}: full-quality video`;
  return { height, upgrade: { label, href: u.url } };
}

/**
 * Whether this account's renders carry the watermark, and why: an admin's per-user choice wins, then the plan
 * (a paid plan removes it), then the instance setting (non-admins get it, admins never do by default).
 */
export async function watermarkFor(
  db: Db,
  instance: InstanceLimits,
  user: { id: string; role: UserRole },
  ent?: Entitlements | null,
): Promise<{ on: boolean; text: string; source: LimitSource | "admin"; upgrade?: WatermarkUpgrade }> {
  const text = instance.WATERMARK_TEXT;
  const [row, grants] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, user.id), columns: { watermark: true } }),
    ent ? ent.grantsFor(db, user.id) : null,
  ]);
  if (typeof row?.watermark === "boolean") return { on: row.watermark, text, source: "override" };
  const upgrade = watermarkUpgrade(grants);
  if (typeof grants?.watermark === "boolean") return { on: grants.watermark, text, source: "plan", ...(grants.watermark && upgrade ? { upgrade } : {}) };
  if (user.role === "admin") return { on: false, text, source: "admin" };
  const on = instance.WATERMARK_NON_ADMINS;
  return { on, text, source: "instance", ...(on && upgrade ? { upgrade } : {}) };
}

/** The plan that takes the watermark off, for the "Remove watermark" button; only when the next plan does. */
export interface WatermarkUpgrade {
  label: string;
  href: string;
}
export function watermarkUpgrade(grants: Grants | null): WatermarkUpgrade | undefined {
  const u = grants?.upgrade;
  if (u?.watermark !== false) return undefined;
  return { label: `${u.planLabel} removes it${u.monthlyPrice ? ` for $${u.monthlyPrice.toLocaleString("en-US")} a month` : ""}`, href: u.url };
}

/** Extra analytics properties on a refusal (`firstVideo`: the account's first video was the one refused). Never content. */
export type RefusalProps = { firstVideo?: boolean };

export class QuotaError extends TRPCError {
  readonly quota?: QuotaRefusal | undefined;
  /** the limit that refused (a LimitKey), for analytics; the refusal's own key when it has one */
  readonly limit: string;
  readonly props: RefusalProps;
  constructor(message: string, quota?: QuotaRefusal, limit?: string, props: RefusalProps = {}) {
    super({ code: "TOO_MANY_REQUESTS", message });
    this.quota = quota;
    this.limit = limit ?? quota?.key ?? "unknown";
    this.props = props;
  }
}

/**
 * A refusal as a product event (`quota.refused`): which limit, the surface (web, api, mcp, cli, or ingest when the length
 * was only known after the project was created), the offer shown, and whether it was the account's first video; never
 * the message.
 */
export function trackQuotaRefusal(telemetry: Pick<Telemetry, "capture">, userId: string, err: QuotaError, surface: string) {
  telemetry.capture("quota.refused", userId, refusalEvent(err.limit, surface, err.quota, err.props));
}

/** The properties `quota.refused` and `quota.warned` share, so a warning and the refusal it heads off line up. */
export function refusalEvent(key: string, surface: string, quota: QuotaRefusal | null | undefined, props: RefusalProps = {}) {
  return {
    key,
    surface,
    ...(quota?.primary ? { offer: quota.primary.kind } : {}),
    ...(props.firstVideo !== undefined ? { firstVideo: props.firstVideo } : {}),
  };
}

/**
 * A video was refused for its length (daily or monthly minutes). Not a fault and not worth a retry: the stage
 * worker fails the project at once instead of downloading the same video again.
 */
export class QuotaExceededError extends NonRetryableError {
  constructor(
    message: string,
    /** the limit that refused, for `quota.refused` */
    readonly limit: LimitKey = "MAX_SOURCE_MINUTES_PER_MONTH",
    readonly quota?: QuotaRefusal,
    readonly props: RefusalProps = {},
  ) {
    super(message, "quota");
    this.name = "QuotaExceededError";
  }
}

/** What the next paid plan would give for this limit, for the upgrade CTA. */
export function upgradeCapacityLabel(upgrade: NonNullable<Grants["upgrade"]>, key: LimitKey): string {
  const n = upgrade.limits[key];
  if (key === "MAX_STORAGE_MB")
    return typeof n === "number" && n > 0 ? `${upgrade.planLabel} gives ${formatMb(n)} of storage` : `Upgrade to ${upgrade.planLabel}`;
  if (key === "MAX_SOURCE_MINUTES_PER_MONTH" || key === "MAX_SOURCE_MINUTES_PER_DAY")
    return typeof n === "number" && n > 0
      ? upgrade.monthlyPrice
        ? `${upgrade.planLabel}: ${n.toLocaleString("en-US")} minutes a month for $${upgrade.monthlyPrice.toLocaleString("en-US")}`
        : `${upgrade.planLabel} gives ${n.toLocaleString("en-US")} minutes a month`
      : `Upgrade to ${upgrade.planLabel}`;
  if (key === "MAX_PROJECTS_PER_USER")
    return typeof n === "number" && n > 0 ? `${upgrade.planLabel} gives ${n.toLocaleString("en-US")} projects` : `Upgrade to ${upgrade.planLabel}`;
  if (key === "MAX_MANUAL_CLIPS_PER_USER")
    return typeof n === "number" && n > 0
      ? `${upgrade.planLabel} gives ${n.toLocaleString("en-US")} clips of your own`
      : `${upgrade.planLabel}: make clips of your own`;
  return `Upgrade to ${upgrade.planLabel}`;
}

function kindOf(key: LimitKey): "storage" | "other" {
  return key === "MAX_STORAGE_MB" ? "storage" : "other";
}

/**
 * Primary CTA is upgrade when a next plan exists; on the top paid plan (or complimentary Pro) it is a
 * request for more capacity (feedback). Storage refusals always offer free space as the other action.
 */
export function quotaRefusal(d: LimitsDetail, key: LimitKey, sentence?: string): QuotaRefusal {
  return { ...refusalActions(d, key), ...(sentence ? { sentence } : {}) };
}

function refusalActions(d: LimitsDetail, key: LimitKey): QuotaRefusal {
  const upgrade = d.grants?.upgrade;
  const billing = d.grants != null;
  const freeSpace: QuotaAction = { kind: "free_space", label: "Free space", href: deletedProjectsPath() };
  const request: QuotaAction = { kind: "request", label: "Request more capacity" };
  if (upgrade) {
    return {
      key,
      primary: { kind: "upgrade", label: upgradeCapacityLabel(upgrade, key), href: upgrade.url },
      secondary: kindOf(key) === "storage" ? freeSpace : undefined,
    };
  }
  if (billing) {
    return { key, primary: request, secondary: kindOf(key) === "storage" ? freeSpace : undefined };
  }
  if (kindOf(key) === "storage") return { key, primary: freeSpace };
  return { key };
}

function refuse(d: LimitsDetail, key: LimitKey, message: string, props: RefusalProps = {}): never {
  throw new QuotaError(message, quotaRefusal(d, key), key, props);
}

/** `refuse`, with the plan's offer and its link after the sentence for text-only readers; the refusal keeps the sentence alone. */
function refuseOffering(d: LimitsDetail, key: LimitKey, sentence: string, props: RefusalProps = {}): never {
  throw new QuotaError(`${sentence}${hint(d, key)}`, quotaRefusal(d, key, sentence), key, props);
}

const nextMidnightUtc = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime() + 86_400_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

/** The window a monthly allowance counts in: the billing period when the account has one, else the UTC calendar month. */
export function periodFor(grants: Grants | null, now = new Date()): { start: Date; end: Date; source: "billing" | "calendar" } {
  if (grants?.period && grants.period.start <= now && now < grants.period.end) return { ...grants.period, source: "billing" };
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, source: "calendar" };
}

/** "Starter gives 10 GB of storage: https://…" when the plan offers a next step, else nothing. */
const hint = (d: LimitsDetail, key: LimitKey = "MAX_SOURCE_MINUTES_PER_MONTH") =>
  d.grants?.upgrade ? ` ${upgradeCapacityLabel(d.grants.upgrade, key)}: ${d.grants.upgrade.url}` : "";

/**
 * Before creating a project. Pass the creating unit of work's `u.db` with `lock: true`: a per-user transaction lock
 * then serialises concurrent creates of one user, so the counts below include every project committed before this one
 * and N parallel requests can't all pass a cap they jointly exceed. (Without `lock` it is only an early, advisory check.)
 */
export async function checkProjectQuota(db: Db, instance: InstanceLimits, userId: string, o: { lock?: boolean; ent?: Entitlements | null } = {}) {
  if (o.lock) await takeTxLock(db, txLock.quota(userId));
  const d = await limitsDetail(db, instance, userId, o.ent);
  const l = d.limits;
  if (l.MAX_STORAGE_MB > 0) checkStorage(d, await storedBytes(db, userId));
  if (l.MAX_PROJECTS_PER_USER > 0) {
    // a deleted project frees its slot at once (it is only kept for undo)
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.projects)
      .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
    if (n >= l.MAX_PROJECTS_PER_USER)
      refuse(d, "MAX_PROJECTS_PER_USER", `You have ${n} projects, the most this account may keep (${l.MAX_PROJECTS_PER_USER}). Delete one to start another.`);
  }
  if (l.MAX_NEW_PROJECTS_PER_HOUR > 0) {
    const since = new Date(Date.now() - 3_600_000);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.sourceUsage)
      .where(and(eq(schema.sourceUsage.userId, userId), ownRow, gte(schema.sourceUsage.createdAt, since)));
    if (n >= l.MAX_NEW_PROJECTS_PER_HOUR)
      refuse(
        d,
        "MAX_NEW_PROJECTS_PER_HOUR",
        `${n} projects started in the last hour, the most allowed (${l.MAX_NEW_PROJECTS_PER_HOUR}). Try again in a while.`,
      );
  }
  if (l.MAX_SOURCE_MINUTES_PER_DAY > 0) {
    const used = await minutesToday(db, userId);
    if (used >= l.MAX_SOURCE_MINUTES_PER_DAY)
      refuse(
        d,
        "MAX_SOURCE_MINUTES_PER_DAY",
        `Daily limit of ${l.MAX_SOURCE_MINUTES_PER_DAY} minutes of video reached (${Math.round(used)} used); resets at ${hhmm(nextMidnightUtc())}.`,
      );
  }
  if (l.MAX_SOURCE_MINUTES_PER_MONTH > 0) {
    const period = periodFor(d.grants);
    const m = await monthlyMinutes(db, userId, period.start, d.grants);
    // a first video on the house is checked for real once its length is known (sourceMinutesExceeded)
    if (m.used >= l.MAX_SOURCE_MINUTES_PER_MONTH && !m.firstPending)
      refuseOffering(
        d,
        "MAX_SOURCE_MINUTES_PER_MONTH",
        `Monthly limit of ${l.MAX_SOURCE_MINUTES_PER_MONTH} minutes of video reached (${Math.round(m.used)} used); resets on ${formatDay(period.end, { year: false, utc: true })}.`,
      );
  }
}

/** Clips the account has added by hand (create_clip, "manual" or "manual-ai"), deleted ones included: deleting one does not give it back. */
export async function manualClipsMade(db: Db, userId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.clips)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
    .where(and(eq(schema.projects.userId, userId), inArray(schema.clips.origin, ["manual", "manual-ai"])));
  return n;
}

/**
 * Before adding a clip by hand. Call inside the creating unit of work: the account's quota lock makes two
 * parallel creates count each other. The refusal carries the upgrade CTA (create_clip, the editor, the CLI).
 */
export async function checkManualClipQuota(db: Db, instance: InstanceLimits, userId: string, ent?: Entitlements | null) {
  await takeTxLock(db, txLock.quota(userId));
  const d = await limitsDetail(db, instance, userId, ent);
  const max = d.limits.MAX_MANUAL_CLIPS_PER_USER;
  if (max <= 0) return;
  const made = await manualClipsMade(db, userId);
  if (made >= max)
    refuseOffering(
      d,
      "MAX_MANUAL_CLIPS_PER_USER",
      `${max === 1 ? "Your free clip of your own is used" : `You have made ${made} clips of your own, the most this account may (${max})`}. The clips Reelsaw found stay yours to edit.`,
    );
}

/**
 * Restore of a soft-deleted project: live slots only. Minutes, hourly creates and storage already counted
 * this project (storage still does, until remove-for-good); bringing it back must not exceed the live cap.
 */
export async function checkRestoreQuota(db: Db, instance: InstanceLimits, userId: string, o: { lock?: boolean; ent?: Entitlements | null } = {}) {
  if (o.lock) await takeTxLock(db, txLock.quota(userId));
  const d = await limitsDetail(db, instance, userId, o.ent);
  if (d.limits.MAX_PROJECTS_PER_USER <= 0) return;
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.projects)
    .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
  if (n >= d.limits.MAX_PROJECTS_PER_USER)
    refuse(
      d,
      "MAX_PROJECTS_PER_USER",
      `You have ${n} projects, the most this account may keep (${d.limits.MAX_PROJECTS_PER_USER}). Delete one to restore another.`,
    );
}

/**
 * Minutes that count against the monthly allowance: every project created since `start`, minus the first-video
 * allowance when the plan has one (the account's earliest project whose length is known, up to `firstVideoFreeMinutes`,
 * is free; a project still downloading, or one that failed before it was probed, has no length and never takes it).
 * `firstPending` = the allowance is still unused (no project has a length yet), so a creation must not be refused on the cap.
 */
export async function monthlyMinutes(
  db: Db,
  userId: string,
  start: Date,
  grants: Grants | null,
  exceptProjectId?: string,
): Promise<{ used: number; firstFree: number; firstPending: boolean }> {
  const total = await minutesSince(db, userId, start, exceptProjectId);
  const free = grants?.firstVideoFreeMinutes ?? 0;
  if (!free) return { used: total, firstFree: 0, firstPending: false };
  const [first] = await db
    .select({ id: schema.sourceUsage.projectId, durationSec: schema.sourceUsage.durationSec, createdAt: schema.sourceUsage.createdAt })
    .from(schema.sourceUsage)
    .where(
      and(
        eq(schema.sourceUsage.userId, userId),
        ownRow,
        isNotNull(schema.sourceUsage.durationSec),
        exceptProjectId ? sql`${schema.sourceUsage.projectId} <> ${exceptProjectId}` : undefined,
      ),
    )
    .orderBy(schema.sourceUsage.createdAt)
    .limit(1);
  if (!first) return { used: total, firstFree: free, firstPending: true };
  // the first video was longer than the allowance: it counts whole (the check that admitted it said so)
  const firstMinutes = (first.durationSec ?? 0) / 60;
  const credit = first.createdAt >= start && firstMinutes <= free ? firstMinutes : 0;
  return { used: Math.max(0, wholeMs(total - credit)), firstFree: free, firstPending: false };
}

/**
 * Before work a person asked for is queued (uow.ts `enqueue`, under the user's job lock): jobs they asked for that are
 * still in flight across every queue (the pipeline's own hand-offs, such as a new project's renders, do not count), and
 * renders, new clips and re-runs (analysis, refinement) asked for in the last hour. `admission` already counts the
 * unit's own earlier enqueues, so a bulk re-render that would pass the limit is refused whole.
 */
export function checkJobLimits(l: Limits, a: Admission, isRender: boolean) {
  if (l.MAX_LIVE_JOBS_PER_USER > 0 && a.userLive >= l.MAX_LIVE_JOBS_PER_USER)
    throw new QuotaError(
      `You have ${a.userLive} requests queued or running, the most this account may have at once (${l.MAX_LIVE_JOBS_PER_USER}). Try again when some have finished.`,
      undefined,
      "MAX_LIVE_JOBS_PER_USER",
    );
  if (isRender && l.MAX_RERENDERS_PER_HOUR > 0 && a.userRendersLastHour >= l.MAX_RERENDERS_PER_HOUR)
    throw new QuotaError(
      `${a.userRendersLastHour} re-renders and re-runs requested in the last hour, the most allowed (${l.MAX_RERENDERS_PER_HOUR}). Try again in a while.`,
      undefined,
      "MAX_RERENDERS_PER_HOUR",
    );
}

/** Before an upload or a new project: what the account stores now (sources, uploads, renders, intros/outros) plus what is arriving. */
export async function checkStorageQuota(db: Db, instance: InstanceLimits, userId: string, incomingBytes = 0, ent?: Entitlements | null) {
  const d = await limitsDetail(db, instance, userId, ent);
  if (d.limits.MAX_STORAGE_MB > 0) checkStorage(d, (await storedBytes(db, userId)) + incomingBytes);
}

/**
 * Room for `incomingBytes` more, decided under the account's quota lock so concurrent uploads cannot all pass a cap they
 * jointly exceed. Call it inside the unit of work that inserts the row the bytes belong to (the lock lasts to commit).
 * Throws the same plain-language storage refusal as the advisory check.
 */
export async function assertStorageRoom(
  svc: { settings: { get(): InstanceLimits }; entitlements: Entitlements | null },
  u: { db: Db },
  userId: string,
  incomingBytes: number,
): Promise<void> {
  await takeTxLock(u.db, txLock.quota(userId));
  await checkStorageQuota(u.db, svc.settings.get(), userId, incomingBytes, svc.entitlements);
}

function checkStorage(d: LimitsDetail, bytes: number) {
  const l = d.limits;
  if (l.MAX_STORAGE_MB <= 0) return;
  const mb = Math.round(bytes / 1_048_576);
  if (mb >= l.MAX_STORAGE_MB)
    refuseOffering(
      d,
      "MAX_STORAGE_MB",
      `This account stores ${mb} MB, the most allowed is ${l.MAX_STORAGE_MB} MB. Removed projects still count until you delete them forever.`,
    );
}

/**
 * An upload whose bytes were not copied into a project's source yet. Ingest copies the upload to the source key and
 * keeps the uploads row (for Retry), so once a project has `source_bytes` the same file would count twice.
 * Expects the uploads table aliased `x`.
 */
const uploadNotCopied = sql`not exists (select 1 from projects p where p.source_meta->>'uploadId' = x.id and p.source_bytes is not null)`;

/**
 * Bytes one account keeps in storage: downloaded sources, uploads, rendered clips and intro/outro assets (removed
 * ones too until remove-for-good / the retention purge). Thumbnails and scratch files are not counted. `output_bytes` counts only while
 * `output_key` is set (a re-render or retention clears the key); clips rendered before it existed count 0.
 */
export async function storedBytes(db: Db, userId: string): Promise<number> {
  const [r] = (await db.execute<{ bytes: string | number }>(sql`select ${storedBytesSql(sql`${userId}`)} as bytes`)).rows;
  return Number(r?.bytes ?? 0);
}

/**
 * `storedBytes` as one SQL value for the account `userId` (a parameter, or an outer column such as `"user"."id"`
 * when the admin list sorts every account by it), so the quota check and the sort cannot count differently.
 */
export function storedBytesSql(userId: SQL): SQL {
  return sql`(coalesce((select sum(source_bytes) from projects where user_id = ${userId}), 0)
      + coalesce((select sum(size_bytes) from uploads x where x.user_id = ${userId} and ${uploadNotCopied}), 0)
      + coalesce((select sum(c.output_bytes) from clips c join projects p on p.id = c.project_id where p.user_id = ${userId} and c.output_key is not null), 0)
      + coalesce((select sum(size_bytes) from assets where user_id = ${userId}), 0))`;
}

/**
 * The all-time usage numbers `usageByUser` reports (`usage.projects`, `sourceMinutes`, `clipsRendered`,
 * `storedBytes`) as SQL values of the account `userId`, for ordering every account by one of them. The stack test
 * `users-sort-stack.test.ts` checks the order matches the numbers the list shows.
 */
export const allTimeUsageSql = {
  projects: (userId: SQL) => sql`(select count(*) from source_usage where user_id = ${userId} and part = 0)`,
  sourceMinutes: (userId: SQL) => sql`(select coalesce(sum(duration_sec), 0) / 60.0 from source_usage where user_id = ${userId})`,
  clipsRendered: (userId: SQL) => sql`(select count(*) from clips c join projects p on p.id = c.project_id where p.user_id = ${userId} and c.status = 'done')`,
  storedBytes: storedBytesSql,
} satisfies Record<string, (userId: SQL) => SQL>;

/** Bytes one project (source + its rendered clips) still occupies; used on the Deleted list and after a delete. */
export async function projectStoredBytes(db: Db, projectId: string): Promise<number> {
  const [r] = (
    await db.execute<{ bytes: string | number }>(sql`
    select
      coalesce((select source_bytes from projects where id = ${projectId}), 0)
      + coalesce((select sum(output_bytes) from clips where project_id = ${projectId} and output_key is not null), 0) as bytes`)
  ).rows;
  return Number(r?.bytes ?? 0);
}

/** A project's own row in the usage ledger (part 0); the other parts are extensions of a partly processed video. */
const ownRow = eq(schema.sourceUsage.part, 0);

/** Insert at create so hourly creates and first-video-free survive a later delete. */
export async function recordProjectCreated(db: Db, userId: string, projectId: string, createdAt: Date) {
  await db.insert(schema.sourceUsage).values({ userId, projectId, part: 0, createdAt }).onConflictDoNothing();
}

/** The project's first finish, once (a re-render finishes again and changes nothing). Kept through purge and forgetting. */
export async function recordProjectFinished(db: Db, projectId: string, eventId: number) {
  await db
    .update(schema.sourceUsage)
    .set({ firstDoneEventId: eventId })
    .where(and(eq(schema.sourceUsage.projectId, projectId), ownRow, isNull(schema.sourceUsage.firstDoneEventId)));
}

/** Fill the seconds processed after ingest (the whole video, or the start a partial project covers); the row already exists from create. */
export async function recordSourceDuration(db: Db, projectId: string, durationSec: number) {
  await db
    .update(schema.sourceUsage)
    .set({ durationSec })
    .where(and(eq(schema.sourceUsage.projectId, projectId), ownRow));
}

/** The seconds the project's own ledger row records, or null before ingest has measured the video (a re-fetch keeps what was admitted). */
export async function recordedSourceSec(db: Db, projectId: string): Promise<number | null> {
  const [r] = await db
    .select({ sec: schema.sourceUsage.durationSec })
    .from(schema.sourceUsage)
    .where(and(eq(schema.sourceUsage.projectId, projectId), ownRow));
  return r?.sec ?? null;
}

/**
 * Record an extension of a partly processed video: a new ledger row (the next part) for the seconds it adds, dated now,
 * so its minutes count in the period it was asked for. Call it under the account's quota lock, in the unit of work that
 * moves the project's limit.
 */
export async function recordSourceExtension(db: Db, userId: string, projectId: string, addedSec: number): Promise<void> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(max(${schema.sourceUsage.part}), 0)::int` })
    .from(schema.sourceUsage)
    .where(eq(schema.sourceUsage.projectId, projectId));
  await db.insert(schema.sourceUsage).values({ userId, projectId, part: (r?.n ?? 0) + 1, durationSec: addedSec, createdAt: new Date() });
}

/**
 * What to process of a video `durationSec` long, from `fromSec` (0 for a new video), with `roomSec` seconds of the
 * account's minutes: all of the rest (`until: null`), the start of it that fits in whole transcription chunks
 * (`until` = the new end, so a later extension starts on a chunk boundary and reuses every chunk already transcribed),
 * or "none" when less than one chunk fits. `roomSec` null = no minutes limit.
 */
export function partialUntil(durationSec: number, fromSec: number, roomSec: number | null, chunkSec: number): { until: number | null } | "none" {
  const rest = durationSec - fromSec;
  // half a second of slack: a 60:00.3 video is "60 minutes" on every screen that rounds it
  if (roomSec === null || rest <= roomSec + 0.5) return { until: null };
  const chunks = Math.floor(roomSec / chunkSec);
  if (chunks < 1) return "none";
  return { until: fromSec + chunks * chunkSec };
}

/**
 * Seconds of source the account's minutes cover right now (the tightest of the day and month limits), null when no
 * minutes limit applies. For a new video (`exceptProjectId` = its own row when it exists, left out of the counts):
 * while the first-video allowance is unused it is the room, when it is larger than what the month has left
 * (`firstVideo`). With `extension`, the room for more of a video already counted. `binding` = the limit that sets the
 * room (the day's or the month's; the month's on a tie, as it resets later), so offers and sentences name the right
 * one and its reset.
 */
export async function minutesRoomSec(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  o: { exceptProjectId?: string | undefined; extension?: boolean; ent?: Entitlements | null | undefined } = {},
): Promise<{ sec: number | null; firstVideo: boolean; binding: MinutesLimitKey | null }> {
  const d = await limitsDetail(db, instance, userId, o.ent);
  const l = d.limits;
  // the tightest room so far and the limit that set it (an object: closures assigning `let`s defeat narrowing)
  const r: { sec: number | null; binding: MinutesLimitKey | null } = { sec: null, binding: null };
  let firstVideo = false;
  const take = (s: number, key: MinutesLimitKey) => {
    if (r.sec === null || s < r.sec || (s === r.sec && key === "MAX_SOURCE_MINUTES_PER_MONTH")) {
      r.sec = s;
      r.binding = key;
    }
  };
  if (l.MAX_SOURCE_MINUTES_PER_DAY > 0)
    take(Math.max(0, l.MAX_SOURCE_MINUTES_PER_DAY - (await minutesToday(db, userId, o.exceptProjectId))) * 60, "MAX_SOURCE_MINUTES_PER_DAY");
  if (l.MAX_SOURCE_MINUTES_PER_MONTH > 0) {
    const m = await monthlyMinutes(db, userId, periodFor(d.grants).start, d.grants, o.exceptProjectId);
    const monthLeft = Math.max(0, l.MAX_SOURCE_MINUTES_PER_MONTH - m.used);
    // the first video is free up to its allowance whatever the month has left; past it, the start that fits is still free
    if (!o.extension && m.firstPending && m.firstFree > monthLeft) {
      take(m.firstFree * 60, "MAX_SOURCE_MINUTES_PER_MONTH");
      firstVideo = r.binding === "MAX_SOURCE_MINUTES_PER_MONTH";
    } else take(monthLeft * 60, "MAX_SOURCE_MINUTES_PER_MONTH");
  }
  return { sec: r.sec, firstVideo, binding: r.binding };
}

/** The two minutes limits; `minutesRoomSec` says which one binds. */
export type MinutesLimitKey = Extract<LimitKey, "MAX_SOURCE_MINUTES_PER_DAY" | "MAX_SOURCE_MINUTES_PER_MONTH">;

/** What a new video of `durationSec` is admitted as: all of it (`until` null), or its start (`until` = the end of the part processed). */
export interface SourceAdmission {
  until: number | null;
  /** the start is processed because of the first-video allowance, not the month's minutes */
  firstVideo: boolean;
  /** the limit that cut it to its start (null when all of it is processed) */
  binding: MinutesLimitKey | null;
}

/**
 * Admit a new video under the minutes limits: whole when it fits, else the start the account's minutes cover (in whole
 * transcription chunks of `chunkSec`), and refused (the QuotaExceededError with the sentence and the upgrade offer)
 * only when less than one chunk fits. `projectId` = its own row, left out of the counts (null before it is created).
 * The binding call runs at ingest under the account's quota lock; create and check_source ask the same question first.
 */
export async function admitSource(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  projectId: string | null,
  durationSec: number,
  chunkSec: number,
  ent?: Entitlements | null,
): Promise<SourceAdmission> {
  const room = await minutesRoomSec(db, instance, userId, { exceptProjectId: projectId ?? undefined, ent });
  const plan = partialUntil(durationSec, 0, room.sec, chunkSec);
  if (plan !== "none") return { until: plan.until, firstVideo: plan.until !== null && room.firstVideo, binding: plan.until !== null ? room.binding : null };
  const over = await minutesOver(db, instance, userId, projectId, durationSec, ent);
  // the room said less than a chunk fits, so a limit is passed; the fallback is only for a limit raised in between
  if (!over) return { until: null, firstVideo: false, binding: null };
  throw new QuotaExceededError(over.message, over.key, quotaRefusal(over.d, over.key, over.sentence), { firstVideo: over.firstVideo });
}

/** Which minutes limit a video of `durationSec` would pass, with the sentence; `projectId` (when it exists) is left out of the counts. */
async function minutesOver(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  projectId: string | null,
  durationSec: number,
  ent?: Entitlements | null,
): Promise<{ d: LimitsDetail; key: LimitKey; message: string; sentence: string; firstVideo: boolean } | null> {
  const d = await limitsDetail(db, instance, userId, ent);
  const l = d.limits;
  const mins = Math.round(durationSec / 60);
  const except = projectId ?? undefined;
  if (l.MAX_SOURCE_MINUTES_PER_DAY > 0) {
    const used = await minutesToday(db, userId, except);
    if (used + durationSec / 60 > l.MAX_SOURCE_MINUTES_PER_DAY)
      return {
        d,
        key: "MAX_SOURCE_MINUTES_PER_DAY",
        message: `This video is ${mins} minutes and you have ${left(l.MAX_SOURCE_MINUTES_PER_DAY, used)} of your ${l.MAX_SOURCE_MINUTES_PER_DAY} minutes a day left. Resets at ${hhmm(nextMidnightUtc())}.`,
        sentence: `This video is ${mins} minutes and you have ${left(l.MAX_SOURCE_MINUTES_PER_DAY, used)} of your ${l.MAX_SOURCE_MINUTES_PER_DAY} minutes a day left. Resets at ${hhmm(nextMidnightUtc())}.`,
        firstVideo: false,
      };
  }
  if (l.MAX_SOURCE_MINUTES_PER_MONTH > 0) {
    const period = periodFor(d.grants);
    const m = await monthlyMinutes(db, userId, period.start, d.grants, except);
    // the account's first video is on the house up to the plan's allowance
    if (m.firstPending && durationSec / 60 <= m.firstFree) return null;
    if (m.used + durationSec / 60 > l.MAX_SOURCE_MINUTES_PER_MONTH) {
      const upgrade = hint(d, "MAX_SOURCE_MINUTES_PER_MONTH");
      // a new account has used nothing: "0 already used passes the limit" read like a fault, so say what does fit
      const fits = Math.max(m.firstFree, left(l.MAX_SOURCE_MINUTES_PER_MONTH, m.used));
      const sentence = m.firstPending
        ? `This video is ${mins} minutes. Your first video is free up to ${m.firstFree} minutes, and after that your plan covers ${l.MAX_SOURCE_MINUTES_PER_MONTH} minutes a month. Try a video under ${fits} minutes.`
        : `This video is ${mins} minutes and you have ${left(l.MAX_SOURCE_MINUTES_PER_MONTH, m.used)} of your ${l.MAX_SOURCE_MINUTES_PER_MONTH} minutes left this period. Resets on ${formatDay(period.end, { year: false, utc: true })}.`;
      return { d, key: "MAX_SOURCE_MINUTES_PER_MONTH", message: `${sentence}${upgrade}`, sentence, firstVideo: m.firstPending };
    }
  }
  return null;
}

/** Whole minutes still free under a cap, never negative. */
const left = (cap: number, used: number) => Math.max(0, Math.floor(cap - used));

/** After ffprobe, when the length is known. Returns the refusal to fail the project with (its sentence is the message), or null. */
export async function sourceMinutesExceeded(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  projectId: string,
  durationSec: number,
  ent?: Entitlements | null,
): Promise<QuotaExceededError | null> {
  const over = await minutesOver(db, instance, userId, projectId, durationSec, ent);
  return over ? new QuotaExceededError(over.message, over.key, quotaRefusal(over.d, over.key, over.sentence), { firstVideo: over.firstVideo }) : null;
}

/** `quota.refused` for a video refused by ingest (its length was only known after the project was created). */
export function trackIngestRefusal(telemetry: Pick<Telemetry, "capture">, userId: string, err: QuotaExceededError) {
  telemetry.capture("quota.refused", userId, refusalEvent(err.limit, "ingest", err.quota, err.props));
}

/** Does a minutes limit apply to this account at all (so a link's length is worth looking up before creating)? */
export async function hasMinuteLimits(db: Db, instance: InstanceLimits, userId: string, ent?: Entitlements | null): Promise<boolean> {
  const { limits: l } = await limitsDetail(db, instance, userId, ent);
  return l.MAX_SOURCE_MINUTES_PER_DAY > 0 || l.MAX_SOURCE_MINUTES_PER_MONTH > 0;
}

/**
 * Before creating a project from a link whose length the site announced: refuse now, as a quota refusal with the upgrade
 * offer, instead of creating a project that ingest would fail. A video whose start fits is not refused: it is admitted
 * as its start (the returned admission). Advisory (no lock): ingest decides again, bound, on the file.
 */
export async function checkAnnouncedMinutes(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  durationSec: number,
  chunkSec: number,
  ent?: Entitlements | null,
): Promise<SourceAdmission> {
  const r = await predictAdmission(db, instance, userId, durationSec, chunkSec, ent);
  if ("refused" in r) throw r.refused;
  return r.admission;
}

/**
 * What a source would be admitted as if it were added now (admitSource's answer, without a project): all of it, its
 * start, or refused with the minutes limit it passes (the sentence and the offer).
 */
export async function predictAdmission(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  durationSec: number,
  chunkSec: number,
  ent?: Entitlements | null,
): Promise<{ admission: SourceAdmission } | { refused: QuotaError }> {
  const room = await minutesRoomSec(db, instance, userId, { ent });
  const plan = partialUntil(durationSec, 0, room.sec, chunkSec);
  if (plan !== "none")
    return { admission: { until: plan.until, firstVideo: plan.until !== null && room.firstVideo, binding: plan.until !== null ? room.binding : null } };
  const over = await minutesOver(db, instance, userId, null, durationSec, ent);
  if (!over) return { admission: { until: null, firstVideo: false, binding: null } };
  return { refused: new QuotaError(over.message, quotaRefusal(over.d, over.key, over.sentence), over.key, { firstVideo: over.firstVideo }) };
}

/** The minutes limit that binds (`binding` from minutesRoomSec; else the month's, else the day's) and its offer: the plan to move to, or a request for more on the top plan, and when it resets. */
export async function minutesOffer(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  ent?: Entitlements | null,
  binding?: MinutesLimitKey | null,
): Promise<{ key: LimitKey; refusal: QuotaRefusal; resetsOn: Date }> {
  const d = await limitsDetail(db, instance, userId, ent);
  const key = binding ?? defaultMinutesKey(d);
  return { key, refusal: quotaRefusal(d, key), resetsOn: key === "MAX_SOURCE_MINUTES_PER_MONTH" ? periodFor(d.grants).end : new Date(nextMidnightUtc()) };
}

/**
 * "Clip the rest" refused because less than one chunk of minutes is left: the sentence, the offer and its link (for
 * MCP and the CLI), like every other minutes refusal.
 */
export async function extensionRefusal(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  remainingSec: number,
  roomSec: number,
  ent?: Entitlements | null,
  binding?: MinutesLimitKey | null,
): Promise<QuotaError> {
  const d = await limitsDetail(db, instance, userId, ent);
  const key = binding ?? defaultMinutesKey(d);
  const resets =
    key === "MAX_SOURCE_MINUTES_PER_MONTH"
      ? ` this period. Resets on ${formatDay(periodFor(d.grants).end, { year: false, utc: true })}.`
      : ` today. Resets at ${hhmm(nextMidnightUtc())}.`;
  const sentence = `The rest of this video is ${plural(Math.round(remainingSec / 60), "minute")} and you have ${plural(Math.floor(roomSec / 60), "minute")} left${resets}`;
  return new QuotaError(`${sentence}${hint(d, key)}`, quotaRefusal(d, key, sentence), key);
}

/** With no room measured: the month's limit when there is one, else the day's. */
const defaultMinutesKey = (d: LimitsDetail): MinutesLimitKey =>
  d.limits.MAX_SOURCE_MINUTES_PER_MONTH > 0 ? "MAX_SOURCE_MINUTES_PER_MONTH" : "MAX_SOURCE_MINUTES_PER_DAY";

/** The monthly minutes allowance as the New Project form states it; null when no minutes limit applies. */
export interface MinutesAllowance {
  /** minutes a month the plan covers */
  perMonth: number;
  /** whole minutes left this period */
  left: number;
  /** the first video is free up to this many minutes, while it has not been used (0 = no such allowance left) */
  firstVideoFree: number;
  /** ISO date the allowance resets */
  resetsOn: string;
}
export async function minutesAllowance(db: Db, instance: InstanceLimits, userId: string, ent?: Entitlements | null): Promise<MinutesAllowance | null> {
  const d = await limitsDetail(db, instance, userId, ent);
  const cap = d.limits.MAX_SOURCE_MINUTES_PER_MONTH;
  if (!(cap > 0)) return null;
  const period = periodFor(d.grants);
  const m = await monthlyMinutes(db, userId, period.start, d.grants);
  return { perMonth: cap, left: left(cap, m.used), firstVideoFree: m.firstPending ? m.firstFree : 0, resetsOn: period.end.toISOString() };
}

const minutesToday = (db: Db, userId: string, exceptProjectId?: string) =>
  minutesSince(db, userId, new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z"), exceptProjectId);

/**
 * Minutes rounded to the millisecond. The ledger stores seconds as `real` (float4) and sums them in SQL, so a total
 * less the first video's credit (the same row read back as a double) leaves a few 1e-8 of a minute: "5 minutes a
 * month" read as 4 left (floor) and admitted one transcription chunk less. Every minutes count the limits read goes
 * through this.
 */
const wholeMs = (minutes: number) => Math.round(minutes * 60_000) / 60_000;

/** Minutes of source video the account added since `start` (by project creation time; a project counts once its length is known). Survives delete and purge. */
export async function minutesSince(db: Db, userId: string, start: Date, exceptProjectId?: string) {
  const [{ m } = { m: 0 }] = await db
    .select({ m: sql<number>`coalesce(sum(${schema.sourceUsage.durationSec}), 0) / 60.0` })
    .from(schema.sourceUsage)
    .where(
      and(
        eq(schema.sourceUsage.userId, userId),
        gte(schema.sourceUsage.createdAt, start),
        exceptProjectId ? sql`${schema.sourceUsage.projectId} <> ${exceptProjectId}` : undefined,
      ),
    );
  return wholeMs(Number(m));
}

/** What each limit counts right now, for the admin Limits dialog and the Billing page: kept projects, minutes since 00:00 UTC and since the period started, projects in the last hour, jobs in flight, renders and re-runs asked for in the last hour, MB stored. */
export async function limitUsage(db: Db, userId: string, grants: Grants | null = null): Promise<Record<LimitKey, number>> {
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.projects)
    .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
  const [{ hour } = { hour: 0 }] = await db
    .select({ hour: sql<number>`count(*)::int` })
    .from(schema.sourceUsage)
    .where(and(eq(schema.sourceUsage.userId, userId), gte(schema.sourceUsage.createdAt, new Date(Date.now() - 3_600_000))));
  const [jobs] = (
    await db.execute<{ live: number; renders: number }>(sql`
    select
      (select count(*)::int from pgboss.job where state in ('created','retry','active') and data->>'by' = 'user' and data->>'userId' = ${userId}) as live,
      (select count(*)::int from pgboss.job where name in ('clip.render','clip.prepare','project.analyze','refine.entities','refine.disfluency','refine.scenes') and data->>'by' = 'user' and data->>'userId' = ${userId} and created_on > now() - interval '1 hour') as renders`)
  ).rows;
  const [rate] = (
    await db.execute<{ minute: number; hour: number }>(
      sql`select coalesce(sum(n) filter (where bucket = date_trunc('minute', now())), 0)::int as minute, coalesce(sum(n), 0)::int as hour from user_rate where user_id = ${userId} and bucket > now() - interval '1 hour'`,
    )
  ).rows;
  return {
    MAX_REQUESTS_PER_MINUTE: Number(rate?.minute ?? 0),
    MAX_REQUESTS_PER_HOUR: Number(rate?.hour ?? 0),
    MAX_PROJECTS_PER_USER: total,
    MAX_SOURCE_MINUTES_PER_DAY: Math.round(await minutesToday(db, userId)),
    MAX_SOURCE_MINUTES_PER_MONTH: Math.round((await monthlyMinutes(db, userId, periodFor(grants).start, grants)).used),
    MAX_NEW_PROJECTS_PER_HOUR: hour,
    MAX_LIVE_JOBS_PER_USER: Number(jobs?.live ?? 0),
    MAX_RERENDERS_PER_HOUR: Number(jobs?.renders ?? 0),
    MAX_STORAGE_MB: Math.round((await storedBytes(db, userId)) / 1_048_576),
    MAX_WEBHOOKS_PER_USER: await db.$count(schema.webhookEndpoints, eq(schema.webhookEndpoints.userId, userId)),
    MAX_MANUAL_CLIPS_PER_USER: await manualClipsMade(db, userId),
  };
}

/**
 * Per-user usage over the last `days`: projects, minutes of source, clips rendered, model calls, tokens and the
 * cost providers reported, seconds of audio transcribed, stored bytes (all time: sources, uploads, renders, intros/outros). One grouped query per metric table over `userIds` (the page the caller is showing), merged here;
 * without ids it covers the first 500 accounts. The all-time projects, minutes, clips and stored bytes are also
 * `allTimeUsageSql` below (the admin list sorts by them in SQL); users-sort-stack.test.ts checks they agree.
 */
export async function usageByUser(db: Db, days: number | null, userIds?: string[]) {
  const ids = userIds ?? (await db.select({ id: schema.user.id }).from(schema.user).orderBy(schema.user.createdAt).limit(500)).map((u) => u.id);
  if (!ids.length) return [];
  // null = all time
  const since = days == null ? sql`'-infinity'::timestamptz` : sql`now() - make_interval(days => ${days}::int)`;
  const { projects: P, clips: C, uploads: U, llmUsage: L, sttUsage: S, assets: B, sourceUsage: SU } = schema;
  const [proj, src, clip, up, llm, stt, rendered, bump] = await Promise.all([
    db
      .select({
        id: P.userId,
        projectsTotal: sql<number>`count(*)::int`,
        sourceBytes: sql<number>`coalesce(sum(${P.sourceBytes}), 0)`,
      })
      .from(P)
      .where(inArray(P.userId, ids))
      .groupBy(P.userId),
    db
      .select({
        id: SU.userId,
        projects: sql<number>`(count(*) filter (where ${SU.createdAt} >= ${since} and ${SU.part} = 0))::int`,
        sourceMinutes: sql<number>`coalesce(sum(${SU.durationSec}) filter (where ${SU.createdAt} >= ${since}), 0) / 60.0`,
      })
      .from(SU)
      .where(inArray(SU.userId, ids))
      .groupBy(SU.userId),
    db
      .select({ id: P.userId, clipsRendered: sql<number>`count(*)::int` })
      .from(C)
      .innerJoin(P, eq(P.id, C.projectId))
      .where(and(inArray(P.userId, ids), eq(C.status, "done"), sql`${C.updatedAt} >= ${since}`))
      .groupBy(P.userId),
    db
      .select({ id: U.userId, bytes: sql<number>`coalesce(sum(${U.sizeBytes}), 0)` })
      .from(U)
      .where(and(inArray(U.userId, ids), sql`not exists (select 1 from projects p where p.source_meta->>'uploadId' = ${U.id} and p.source_bytes is not null)`))
      .groupBy(U.userId),
    db
      .select({
        id: L.userId,
        llmCalls: sql<number>`count(*)::int`,
        llmInputTokens: sql<number>`coalesce(sum(${L.inputTokens}), 0)`,
        llmOutputTokens: sql<number>`coalesce(sum(${L.outputTokens}), 0)`,
        llmCostUsd: sql<number | null>`sum(${L.costUsd})`,
      })
      .from(L)
      .where(and(inArray(L.userId, ids), sql`${L.createdAt} >= ${since}`))
      .groupBy(L.userId),
    db
      .select({ id: S.userId, sttCalls: sql<number>`count(*)::int`, sttSeconds: sql<number>`coalesce(sum(${S.audioSec}), 0)` })
      .from(S)
      .where(and(inArray(S.userId, ids), sql`${S.createdAt} >= ${since}`))
      .groupBy(S.userId),
    db
      .select({ id: P.userId, bytes: sql<number>`coalesce(sum(${C.outputBytes}), 0)` })
      .from(C)
      .innerJoin(P, eq(P.id, C.projectId))
      .where(and(inArray(P.userId, ids), sql`${C.outputKey} is not null`))
      .groupBy(P.userId),
    db
      .select({ id: B.userId, bytes: sql<number>`coalesce(sum(${B.sizeBytes}), 0)` })
      .from(B)
      .where(inArray(B.userId, ids))
      .groupBy(B.userId),
  ]);
  const by = <T extends { id: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const [pm, srcm, cm, um, lm, sm, rm, bm] = [by(proj), by(src), by(clip), by(up), by(llm), by(stt), by(rendered), by(bump)];
  return ids.map((id) => {
    const p = pm.get(id);
    const u = srcm.get(id);
    const l = lm.get(id);
    const s = sm.get(id);
    return {
      id,
      projects: u?.projects ?? 0,
      projectsTotal: p?.projectsTotal ?? 0,
      sourceMinutes: Math.round(Number(u?.sourceMinutes ?? 0)),
      clipsRendered: cm.get(id)?.clipsRendered ?? 0,
      storedBytes: Number(p?.sourceBytes ?? 0) + Number(um.get(id)?.bytes ?? 0) + Number(rm.get(id)?.bytes ?? 0) + Number(bm.get(id)?.bytes ?? 0),
      llmCalls: l?.llmCalls ?? 0,
      llmInputTokens: Number(l?.llmInputTokens ?? 0),
      llmOutputTokens: Number(l?.llmOutputTokens ?? 0),
      /** null when no call in the window reported a price (self-hosted and most direct providers) */
      llmCostUsd: l?.llmCostUsd == null ? null : Number(Number(l.llmCostUsd).toFixed(4)),
      sttCalls: s?.sttCalls ?? 0,
      sttMinutes: Math.round(Number(s?.sttSeconds ?? 0) / 6) / 10,
    };
  });
}

/** The limits that stay a wall after a downgrade (each refuses new work until usage is under it again), in the order they bite. */
const WALL_KEYS = ["MAX_STORAGE_MB", "MAX_PROJECTS_PER_USER", "MAX_SOURCE_MINUTES_PER_MONTH"] as const satisfies readonly LimitKey[];
export type Overage = { key: (typeof WALL_KEYS)[number]; used: number; limit: number; sentence: string };

/** What a wall counts that no plan changes (kept projects, MB stored): one read the Billing page and its preview of Free share. */
export type WallUsage = Pick<Record<LimitKey, number>, "MAX_PROJECTS_PER_USER" | "MAX_STORAGE_MB">;

/**
 * Where the account is at or over the limits `detail` gives it (the limitsDetail of a plan it is about to fall
 * back to): what would be refused, said once for the Billing page, `get_billing` and the billing mails. Admin
 * overrides still apply. Monthly minutes count the window that plan would use, and only when `at` is inside the
 * current one (a plan ending next month starts on a fresh allowance). `kept` is usage already read for the page.
 */
export async function overages(db: Db, userId: string, detail: LimitsDetail, at = new Date(), kept?: WallUsage): Promise<Overage[]> {
  const month = periodFor(detail.grants, at);
  const thisMonth = month.start.getTime() === periodFor(detail.grants).start.getTime();
  const [projects, storedMb, minutes] = await Promise.all([
    kept ? kept.MAX_PROJECTS_PER_USER : db.$count(schema.projects, and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt))),
    kept ? kept.MAX_STORAGE_MB : storedBytes(db, userId).then((b) => Math.round(b / 1_048_576)),
    thisMonth && detail.limits.MAX_SOURCE_MINUTES_PER_MONTH > 0 ? monthlyMinutes(db, userId, month.start, detail.grants).then((m) => Math.round(m.used)) : 0,
  ]);
  const usage = { MAX_STORAGE_MB: storedMb, MAX_PROJECTS_PER_USER: projects, MAX_SOURCE_MINUTES_PER_MONTH: minutes };
  const label = detail.grants?.planLabel ?? "the plan";
  const out: Overage[] = [];
  for (const key of WALL_KEYS) {
    const limit = detail.limits[key];
    const used = usage[key];
    if (limit <= 0 || used < limit) continue;
    if (key === "MAX_SOURCE_MINUTES_PER_MONTH" && !thisMonth) continue;
    const sentence =
      key === "MAX_STORAGE_MB"
        ? `${formatMb(used)} stored, and ${label} keeps ${formatMb(limit)}: new projects and uploads are refused until you delete some (removed projects count until deleted forever).`
        : key === "MAX_PROJECTS_PER_USER"
          ? `${plural(used, "project")}, and ${label} keeps ${limit}: new projects and restores are refused until you delete some.`
          : `${plural(used, "minute")} of video used this month, and ${label} allows ${limit}: new videos are refused until ${formatDay(month.end, { year: false, utc: true })}.`;
    out.push({ key, used, limit, sentence });
  }
  return out;
}
