/**
 * Quotas: one precedence chain per number (README, "Settings and precedence"): the environment, then the
 * admin's runtime override (instance-settings.ts), then what the account's plan grants (`Entitlements`,
 * provided by ee/ on a hosted instance; null self-hosted), then an admin's per-user override
 * (`user_settings.limits`). 0 = unlimited. Refusals are sentences the user can act on, with the plan's
 * upgrade hint when there is one. Checked where the number is known: project count and rate at creation,
 * source minutes at creation when the link announces its length and bound once ffprobe has run, storage at upload. The watermark follows the same chain.
 */
import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { deletedProjectsPath, type QuotaAction, type QuotaRefusal } from "@reelsaw/shared";
import { schema, type Db } from "./db/index.js";
import type { RuntimeSettings } from "./instance-settings.js";
import type { Admission } from "./queue/boss.js";
import type { UserRole } from "./db/schema.js";
import { takeTxLock, txLock } from "./locks.js";
import { NonRetryableError } from "./pipeline/common.js";

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
  /** the billing period, when the account has one; monthly allowances count inside it */
  period: { start: Date; end: Date } | null;
  /** appended to a refusal: "Pro gives 1,200 minutes a month" and where to go; `plan`/`limits` drive the upgrade CTA */
  upgrade?: { text: string; url: string; plan: string; planLabel: string; limits: Partial<Limits> };
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

/**
 * Whether this account's renders carry the watermark, and why: an admin's per-user choice wins, then the plan
 * (a paid plan removes it), then the instance setting (non-admins get it, admins never do by default).
 */
export async function watermarkFor(
  db: Db,
  instance: InstanceLimits,
  user: { id: string; role: UserRole },
  ent?: Entitlements | null,
): Promise<{ on: boolean; text: string; source: LimitSource | "admin" }> {
  const text = instance.WATERMARK_TEXT;
  const [row, grants] = await Promise.all([
    db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, user.id), columns: { watermark: true } }),
    ent ? ent.grantsFor(db, user.id) : null,
  ]);
  if (typeof row?.watermark === "boolean") return { on: row.watermark, text, source: "override" };
  if (typeof grants?.watermark === "boolean") return { on: grants.watermark, text, source: "plan" };
  if (user.role === "admin") return { on: false, text, source: "admin" };
  return { on: instance.WATERMARK_NON_ADMINS, text, source: "instance" };
}

export class QuotaError extends TRPCError {
  readonly quota?: QuotaRefusal | undefined;
  constructor(message: string, quota?: QuotaRefusal) {
    super({ code: "TOO_MANY_REQUESTS", message });
    this.quota = quota;
  }
}

/**
 * A video was refused for its length (daily or monthly minutes). Not a fault and not worth a retry: the stage
 * worker fails the project at once instead of downloading the same video again.
 */
export class QuotaExceededError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

function formatMb(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toLocaleString("en-US")} MB`;
}

/** What the next paid plan would give for this limit, for the upgrade CTA. */
export function upgradeCapacityLabel(upgrade: NonNullable<Grants["upgrade"]>, key: LimitKey): string {
  const n = upgrade.limits[key];
  if (key === "MAX_STORAGE_MB")
    return typeof n === "number" && n > 0 ? `${upgrade.planLabel} gives ${formatMb(n)} of storage` : `Upgrade to ${upgrade.planLabel}`;
  if (key === "MAX_SOURCE_MINUTES_PER_MONTH" || key === "MAX_SOURCE_MINUTES_PER_DAY")
    return typeof n === "number" && n > 0 ? `${upgrade.planLabel} gives ${n.toLocaleString("en-US")} minutes a month` : `Upgrade to ${upgrade.planLabel}`;
  if (key === "MAX_PROJECTS_PER_USER")
    return typeof n === "number" && n > 0 ? `${upgrade.planLabel} gives ${n.toLocaleString("en-US")} projects` : `Upgrade to ${upgrade.planLabel}`;
  return `Upgrade to ${upgrade.planLabel}`;
}

function kindOf(key: LimitKey): "storage" | "other" {
  return key === "MAX_STORAGE_MB" ? "storage" : "other";
}

/**
 * Primary CTA is upgrade when a next plan exists; on the top paid plan (or complimentary Pro) it is a
 * request for more capacity (feedback). Storage refusals always offer free space as the other action.
 */
export function quotaRefusal(d: LimitsDetail, key: LimitKey): QuotaRefusal {
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

function refuse(d: LimitsDetail, key: LimitKey, message: string): never {
  throw new QuotaError(message, quotaRefusal(d, key));
}

const nextMidnightUtc = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime() + 86_400_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";
const dayOf = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

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
      .where(and(eq(schema.sourceUsage.userId, userId), gte(schema.sourceUsage.createdAt, since)));
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
      refuse(
        d,
        "MAX_SOURCE_MINUTES_PER_MONTH",
        `Monthly limit of ${l.MAX_SOURCE_MINUTES_PER_MONTH} minutes of video reached (${Math.round(m.used)} used); resets on ${dayOf(period.end)}.${hint(d, "MAX_SOURCE_MINUTES_PER_MONTH")}`,
      );
  }
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
  return { used: Math.max(0, total - credit), firstFree: free, firstPending: false };
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
    );
  if (isRender && l.MAX_RERENDERS_PER_HOUR > 0 && a.userRendersLastHour >= l.MAX_RERENDERS_PER_HOUR)
    throw new QuotaError(
      `${a.userRendersLastHour} re-renders and re-runs requested in the last hour, the most allowed (${l.MAX_RERENDERS_PER_HOUR}). Try again in a while.`,
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
    refuse(
      d,
      "MAX_STORAGE_MB",
      `This account stores ${mb} MB, the most allowed is ${l.MAX_STORAGE_MB} MB. Removed projects still count until you delete them forever.${hint(d, "MAX_STORAGE_MB")}`,
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
  const [r] = (
    await db.execute<{ bytes: string | number }>(sql`
    select
      coalesce((select sum(source_bytes) from projects where user_id = ${userId}), 0)
      + coalesce((select sum(size_bytes) from uploads x where x.user_id = ${userId} and ${uploadNotCopied}), 0)
      + coalesce((select sum(c.output_bytes) from clips c join projects p on p.id = c.project_id where p.user_id = ${userId} and c.output_key is not null), 0)
      + coalesce((select sum(size_bytes) from assets where user_id = ${userId}), 0) as bytes`)
  ).rows;
  return Number(r?.bytes ?? 0);
}

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

/** Insert at create so hourly creates and first-video-free survive a later delete. */
export async function recordProjectCreated(db: Db, userId: string, projectId: string, createdAt: Date) {
  await db.insert(schema.sourceUsage).values({ userId, projectId, createdAt }).onConflictDoNothing();
}

/** Fill duration after ingest; the row already exists from create. */
export async function recordSourceDuration(db: Db, projectId: string, durationSec: number) {
  await db.update(schema.sourceUsage).set({ durationSec }).where(eq(schema.sourceUsage.projectId, projectId));
}

/** Which minutes limit a video of `durationSec` would pass, with the sentence; `projectId` (when it exists) is left out of the counts. */
async function minutesOver(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  projectId: string | null,
  durationSec: number,
  ent?: Entitlements | null,
): Promise<{ d: LimitsDetail; key: LimitKey; message: string } | null> {
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
        message: `This video is ${mins} minutes; with ${Math.round(used)} already used today that passes the daily limit of ${l.MAX_SOURCE_MINUTES_PER_DAY} minutes. Resets at ${hhmm(nextMidnightUtc())}.`,
      };
  }
  if (l.MAX_SOURCE_MINUTES_PER_MONTH > 0) {
    const period = periodFor(d.grants);
    const m = await monthlyMinutes(db, userId, period.start, d.grants, except);
    // the account's first video is on the house up to the plan's allowance
    if (m.firstPending && durationSec / 60 <= m.firstFree) return null;
    if (m.used + durationSec / 60 > l.MAX_SOURCE_MINUTES_PER_MONTH) {
      const firstNote = m.firstPending ? ` (a first video is free up to ${m.firstFree} minutes; this one is longer)` : "";
      return {
        d,
        key: "MAX_SOURCE_MINUTES_PER_MONTH",
        message: `This video is ${mins} minutes; with ${Math.round(m.used)} already used this period that passes the monthly limit of ${l.MAX_SOURCE_MINUTES_PER_MONTH} minutes${firstNote}. Resets on ${dayOf(period.end)}.${hint(d, "MAX_SOURCE_MINUTES_PER_MONTH")}`,
      };
    }
  }
  return null;
}

/** After ffprobe, when the length is known. Returns a sentence to fail the project with, or null. */
export async function sourceMinutesExceeded(
  db: Db,
  instance: InstanceLimits,
  userId: string,
  projectId: string,
  durationSec: number,
  ent?: Entitlements | null,
): Promise<string | null> {
  return (await minutesOver(db, instance, userId, projectId, durationSec, ent))?.message ?? null;
}

/** Does a minutes limit apply to this account at all (so a link's length is worth looking up before creating)? */
export async function hasMinuteLimits(db: Db, instance: InstanceLimits, userId: string, ent?: Entitlements | null): Promise<boolean> {
  const { limits: l } = await limitsDetail(db, instance, userId, ent);
  return l.MAX_SOURCE_MINUTES_PER_DAY > 0 || l.MAX_SOURCE_MINUTES_PER_MONTH > 0;
}

/**
 * Before creating a project from a link whose length the site announced: refuse now, as a quota refusal with the upgrade
 * offer, instead of creating a project that ingest would fail. Advisory (no lock): ingest checks again, bound, on the file.
 */
export async function checkAnnouncedMinutes(db: Db, instance: InstanceLimits, userId: string, durationSec: number, ent?: Entitlements | null): Promise<void> {
  const over = await minutesOver(db, instance, userId, null, durationSec, ent);
  if (over) refuse(over.d, over.key, over.message);
}

const minutesToday = (db: Db, userId: string, exceptProjectId?: string) =>
  minutesSince(db, userId, new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z"), exceptProjectId);

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
  return Number(m);
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
  };
}

/**
 * Per-user usage over the last `days`: projects, minutes of source, clips rendered, model calls, tokens and the
 * cost providers reported, seconds of audio transcribed, stored bytes (all time: sources, uploads, renders, intros/outros). One grouped query per metric table over `userIds` (the page the caller is showing), merged here;
 * without ids it covers the first 500 accounts.
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
        projects: sql<number>`(count(*) filter (where ${SU.createdAt} >= ${since}))::int`,
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
