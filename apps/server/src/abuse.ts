/**
 * Free-tier abuse controls, all off by default self-hosted and switched on by instance settings:
 *
 *   - sign-up guards (`signupGuard`, called from the Better Auth create hook): accounts per IP per day,
 *     disposable email domains, one account per real mailbox (`emailKey`: lower-case, gmail dots and +tags
 *     folded; a unique index on `user.email_key` enforces it);
 *   - a per-account request rate on mutations and MCP tool calls (`checkRequestRate`): one upsert per call
 *     into `user_rate` minute buckets, so it holds across replicas;
 *   - flagging (`flagAccounts`, hourly from the reconciler): accounts that share a sign-up IP, sign-up bursts,
 *     disposable domains that slipped through, heavy first-day use. Flags are shown on the Users page and
 *     audited (`user.flagged`); nothing is suspended automatically. The hard caps (quotas, plans) do the
 *     containing; flags tell the admin where to look.
 *
 * Every refusal is a sentence. Nothing here reads the request body or the video.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import disposable from "disposable-email-domains/index.json" with { type: "json" };
import { schema, type Db } from "./db/index.js";
import type { Services } from "./services.js";
import type { RuntimeSettings } from "./instance-settings.js";
import { limitsFor, type Entitlements, type InstanceLimits } from "./quota.js";
import type { Logger } from "./log.js";

const DISPOSABLE = new Set<string>(disposable as string[]);

/**
 * The client's address. Behind a reverse proxy (Caddy, Cloudflare; TRUST_PROXY=true, the default for the
 * Docker deployment) the proxy's headers name it; otherwise they are whatever the client sent, so they are
 * ignored and the guard keys on "unknown" (which never counts).
 */
export function clientIp(headers: Headers, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || null;
}

/** One key per real mailbox: lower-case; gmail ignores dots and everything after `+`; other providers honour `+tags` too. */
export function emailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return e;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1).replace(/^googlemail\.com$/, "gmail.com");
  local = local.replace(/\+.*$/, "");
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function isDisposable(email: string): boolean {
  const d = emailDomain(email);
  if (!d) return false;
  if (DISPOSABLE.has(d)) return true;
  // subdomains of a listed domain (mail.tempmail.example)
  const parts = d.split(".");
  for (let i = 1; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  return false;
}

export class SignupRefused extends Error {}

/**
 * Before a user row is inserted. Returns what to store on it. Throws `SignupRefused` with a sentence the
 * form shows. Counts are read from the database, so they hold across replicas; a race between two sign-ups
 * from one IP can overshoot the cap by one, which is fine for a guard.
 */
export async function signupGuard(db: Db, s: Pick<RuntimeSettings, "MAX_SIGNUPS_PER_IP_PER_DAY" | "BLOCK_DISPOSABLE_EMAILS">, input: { email: string; ip: string | null }, log: Logger): Promise<{ emailKey: string; signupIp: string | null }> {
  const key = emailKey(input.email);
  if (s.BLOCK_DISPOSABLE_EMAILS && isDisposable(input.email)) {
    log.warn({ domain: emailDomain(input.email), ip: input.ip }, "sign-up refused: disposable email domain");
    throw new SignupRefused("Temporary email addresses cannot be used here. Sign up with an address you keep.");
  }
  const [dup] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.emailKey, key)).limit(1);
  if (dup) {
    log.warn({ ip: input.ip }, "sign-up refused: same mailbox as an existing account");
    throw new SignupRefused("An account already exists for this email address. Sign in, or reset your password.");
  }
  if (s.MAX_SIGNUPS_PER_IP_PER_DAY > 0 && input.ip) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.user)
      .where(and(eq(schema.user.signupIp, input.ip), gte(schema.user.createdAt, new Date(Date.now() - 86_400_000))));
    if (n >= s.MAX_SIGNUPS_PER_IP_PER_DAY) {
      log.warn({ ip: input.ip, n, max: s.MAX_SIGNUPS_PER_IP_PER_DAY }, "sign-up refused: accounts per IP per day");
      throw new SignupRefused("Too many accounts were created from this network today. Try again tomorrow, or sign in to the account you have.");
    }
  }
  return { emailKey: key, signupIp: input.ip };
}

/**
 * Per-account request rate for mutations (tRPC and MCP tool calls). The caps follow the quota chain (instance
 * setting, plan, admin's per-user override; quota.ts); 0 = off. One upsert into the current minute bucket, then
 * the minute and the trailing hour are compared with the caps. Refuses with a sentence.
 */
export async function checkRequestRate(db: Db, instance: InstanceLimits, userId: string, ent?: Entitlements | null): Promise<void> {
  if (instance.MAX_REQUESTS_PER_MINUTE <= 0 && instance.MAX_REQUESTS_PER_HOUR <= 0 && !ent) {
    // nothing instance-wide and no plans: skip the override read too (self-hosted default path costs nothing)
    const [o] = await db.select({ limits: schema.userSettings.limits }).from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).limit(1);
    if (!o?.limits?.MAX_REQUESTS_PER_MINUTE && !o?.limits?.MAX_REQUESTS_PER_HOUR) return;
  }
  const s = await limitsFor(db, instance, userId, ent);
  if (s.MAX_REQUESTS_PER_MINUTE <= 0 && s.MAX_REQUESTS_PER_HOUR <= 0) return;
  const [row] = (
    await db.execute(sql`
      with up as (
        insert into user_rate (user_id, bucket, n) values (${userId}, date_trunc('minute', now()), 1)
        on conflict (user_id, bucket) do update set n = user_rate.n + 1
        returning n
      )
      select (select n from up) as minute, (select coalesce(sum(n), 0)::int from user_rate where user_id = ${userId} and bucket > now() - interval '1 hour') as hour`)
  ).rows as Array<{ minute: number; hour: number }>;
  const minute = Number(row?.minute ?? 0);
  const hour = Number(row?.hour ?? 0);
  if (s.MAX_REQUESTS_PER_MINUTE > 0 && minute > s.MAX_REQUESTS_PER_MINUTE) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `More than ${s.MAX_REQUESTS_PER_MINUTE} changes in a minute from this account. Slow down and try again shortly.` });
  if (s.MAX_REQUESTS_PER_HOUR > 0 && hour > s.MAX_REQUESTS_PER_HOUR) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `More than ${s.MAX_REQUESTS_PER_HOUR} changes in an hour from this account. Try again later.` });
}

/** Buckets older than two hours are never read again. */
export async function pruneRequestRate(db: Db): Promise<number> {
  const r = await db.execute(sql`delete from user_rate where bucket < now() - interval '2 hours'`);
  return Number(r.rowCount ?? 0);
}

export const ABUSE_FLAGS = ["shared_ip", "signup_burst", "disposable_email", "heavy_first_day"] as const;
export type AbuseFlag = (typeof ABUSE_FLAGS)[number];
export const FLAG_HELP: Record<AbuseFlag, string> = {
  shared_ip: "three or more accounts signed up from the same address in the last 7 days",
  signup_burst: "five or more accounts from the same address within one hour",
  disposable_email: "the email domain is a known temporary-address service",
  heavy_first_day: "an hour or more of source video in the account's first 24 hours",
};

/**
 * Recompute the flags of recent accounts (hourly). Idempotent: the computed set replaces the stored one, and an
 * admin event is written only when it changed. Looks at accounts created in the last 30 days, in one grouped
 * query per rule, so the cost does not grow with the whole user table.
 */
export async function flagAccounts(svc: Pick<Services, "database" | "log" | "tx"> & { telemetry?: Services["telemetry"] }): Promise<{ checked: number; flagged: number; changed: number }> {
  const db = svc.database.db;
  const log = svc.log.child({ module: "abuse" });
  const since = sql`now() - interval '30 days'`;
  const recent = await db.select({ id: schema.user.id, email: schema.user.email, signupIp: schema.user.signupIp, flags: schema.user.flags, role: schema.user.role }).from(schema.user).where(sql`${schema.user.createdAt} >= ${since}`).limit(5000);
  if (!recent.length) return { checked: 0, flagged: 0, changed: 0 };
  const sharedIps = new Set((await db.execute(sql`select signup_ip from "user" where created_at >= now() - interval '7 days' and signup_ip is not null group by signup_ip having count(*) >= 3`)).rows.map((r) => (r as { signup_ip: string }).signup_ip));
  const burstIps = new Set((await db.execute(sql`select signup_ip from "user" where created_at >= now() - interval '7 days' and signup_ip is not null group by signup_ip, date_trunc('hour', created_at) having count(*) >= 5`)).rows.map((r) => (r as { signup_ip: string }).signup_ip));
  const heavy = new Set(
    (
      await db.execute(sql`
        select p.user_id from projects p join "user" u on u.id = p.user_id
        where u.created_at >= ${since} and p.created_at <= u.created_at + interval '24 hours'
        group by p.user_id having coalesce(sum(p.duration_sec), 0) >= 3600`)
    ).rows.map((r) => (r as { user_id: string }).user_id),
  );
  let flagged = 0;
  let changed = 0;
  for (const u of recent) {
    if (u.role === "admin") continue;
    const next: AbuseFlag[] = [];
    if (u.signupIp && sharedIps.has(u.signupIp)) next.push("shared_ip");
    if (u.signupIp && burstIps.has(u.signupIp)) next.push("signup_burst");
    if (isDisposable(u.email)) next.push("disposable_email");
    if (heavy.has(u.id)) next.push("heavy_first_day");
    if (next.length) flagged++;
    const cur = [...(u.flags ?? [])].sort().join(",");
    if (cur === [...next].sort().join(",")) continue;
    changed++;
    await svc.tx(async (t) => {
      await t.db.update(schema.user).set({ flags: next, updatedAt: new Date() }).where(eq(schema.user.id, u.id));
      await t.db.insert(schema.adminEvents).values({ type: "user.flagged", actorId: null, userId: u.id, email: u.email, payload: { flags: next, was: u.flags ?? [] } });
    });
    log[next.length ? "warn" : "info"]({ userId: u.id, flags: next, was: u.flags ?? [] }, next.length ? "account flagged" : "account flags cleared");
    if (next.length) svc.telemetry?.capture("user.flagged", u.id, { flags: next });
  }
  log.info({ checked: recent.length, flagged, changed }, "abuse flags recomputed");
  return { checked: recent.length, flagged, changed };
}
