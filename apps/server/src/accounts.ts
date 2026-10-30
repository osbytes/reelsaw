/**
 * Account administration: approve, change role, suspend, remove, set password. One function per
 * transition, each a unit of work that writes the user row and its admin event together and sends
 * mail after commit. tRPC (admin router) and the CLI call these; nothing else edits role/approval
 * columns or the credential hash.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { MUST_CHANGE_PASSWORD_REUSE, passwordLengthError } from "@reelsaw/shared";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import type { UnitOfWork } from "./uow.js";
import { templates } from "./email.js";
import { purgeProject } from "./projects/service.js";
import type { UserRole } from "./db/schema.js";

/** The admin event is the record; this is the same fact in the log, written once the change has committed. */
function audit(svc: Services, u: UnitOfWork, action: string, actorId: string | null, userId: string) {
  u.afterCommit(() => svc.log.child({ module: "accounts", userId }).info({ action, actorId }, "admin action"));
}

async function lockedUser(u: UnitOfWork, id: string) {
  const [row] = await u.db.select().from(schema.user).where(eq(schema.user.id, id)).for("update");
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such user" });
  return row;
}

async function otherAdmins(u: UnitOfWork, exceptId: string) {
  const [{ n } = { n: 0 }] = await u.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.user)
    .where(and(eq(schema.user.role, "admin"), ne(schema.user.id, exceptId), eq(schema.user.banned, false)));
  return n;
}

export async function approveUser(svc: Services, actorId: string | null, userId: string) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    if (user.approvedAt) return { ok: true, changed: false };
    await u.db.update(schema.user).set({ approvedAt: new Date(), updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await u.db.insert(schema.adminEvents).values({ type: "user.approved", actorId, userId, email: user.email, payload: {} });
    audit(svc, u, "user.approved", actorId, userId);
    u.afterCommit(() => svc.email.send({ to: user.email, ...templates.approved(svc.config.APP_URL) }));
    return { ok: true, changed: true };
  });
}

export async function setUserRole(svc: Services, actorId: string | null, userId: string, role: UserRole) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    if (user.role === role) return { ok: true, changed: false };
    if (role !== "admin" && userId === actorId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot remove your own admin role. Ask another admin." });
    if (role !== "admin" && user.role === "admin" && (await otherAdmins(u, userId)) === 0)
      throw new TRPCError({ code: "BAD_REQUEST", message: "This is the only admin. Make someone else an admin first." });
    await u.db.update(schema.user).set({ role, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await u.db.insert(schema.adminEvents).values({ type: "user.role_changed", actorId, userId, email: user.email, payload: { from: user.role, to: role } });
    audit(svc, u, "user.role_changed", actorId, userId);
    return { ok: true, changed: true };
  });
}

export async function banUser(svc: Services, actorId: string, userId: string, reason: string | null) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    if (userId === actorId) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot suspend yourself." });
    if (user.role === "admin" && (await otherAdmins(u, userId)) === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This is the only admin." });
    await u.db.update(schema.user).set({ banned: true, banReason: reason, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    // their browser sessions end now; API keys fail at the next request (requester reads the row)
    await u.db.delete(schema.session).where(eq(schema.session.userId, userId));
    await u.db.insert(schema.adminEvents).values({ type: "user.banned", actorId, userId, email: user.email, payload: { reason } });
    audit(svc, u, "user.banned", actorId, userId);
    return { ok: true };
  });
}

export async function unbanUser(svc: Services, actorId: string, userId: string) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    await u.db.update(schema.user).set({ banned: false, banReason: null, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await u.db.insert(schema.adminEvents).values({ type: "user.unbanned", actorId, userId, email: user.email, payload: {} });
    audit(svc, u, "user.unbanned", actorId, userId);
    return { ok: true };
  });
}

/** Delete the account and everything it owns (projects, clips, files, keys, sessions). */
export async function removeUser(svc: Services, actorId: string | null, userId: string) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    if (userId === actorId) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot remove your own account from here." });
    if (user.role === "admin" && (await otherAdmins(u, userId)) === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This is the only admin." });
    const projects = await u.db.query.projects.findMany({ where: eq(schema.projects.userId, userId), columns: { id: true } });
    // hosted: the Stripe subscription must stop billing too; read what to cancel before the rows cascade away
    const cancelAtStripe = svc.ee ? await svc.ee.billing.detachUser(u, userId) : null;
    // removing an account is final: its projects (deleted ones included) go now, not after the restore window
    for (const p of projects) await purgeProject(svc, u, p.id);
    await u.db.delete(schema.user).where(eq(schema.user.id, userId)); // sessions, accounts, keys, uploads cascade
    await u.db.delete(schema.sourceUsage).where(eq(schema.sourceUsage.userId, userId)); // no FK: it outlives project purges, not the account
    await u.db.insert(schema.adminEvents).values({ type: "user.removed", actorId, userId, email: user.email, payload: { projects: projects.length } });
    audit(svc, u, "user.removed", actorId, userId);
    // after commit, best effort: a failure is logged and the daily reconcile lists the orphan
    if (cancelAtStripe) u.afterCommit(cancelAtStripe);
    return { ok: true, projects: projects.length };
  });
}

/**
 * The admin's per-user watermark decision: true (always), false (never) or null (follow the plan and the
 * instance setting). Applies to the next render; existing clips keep what they were rendered with.
 */
export async function setUserWatermark(svc: Services, actorId: string | null, userId: string, watermark: boolean | null) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    await u.db
      .insert(schema.userSettings)
      .values({ userId, watermark })
      .onConflictDoUpdate({ target: schema.userSettings.userId, set: { watermark, updatedAt: new Date() } });
    await u.db.insert(schema.adminEvents).values({ type: "user.watermark_changed", actorId, userId, email: user.email, payload: { watermark } });
    audit(svc, u, "user.watermark_changed", actorId, userId);
    return { ok: true, watermark };
  });
}

/**
 * Per-user quota overrides (null = back to the instance setting). One statement merges the
 * patch into the jsonb (no read-modify-write), and the admin event commits with it.
 */
export async function setUserLimits(svc: Services, actorId: string, userId: string, patch: Record<string, number | null>) {
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null)) as Record<string, number>;
  const unset = Object.keys(patch).filter((k) => patch[k] === null);
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    const [row] = await u.db
      .insert(schema.userSettings)
      .values({ userId, limits: set })
      .onConflictDoUpdate({
        target: schema.userSettings.userId,
        set: {
          limits: sql`(${schema.userSettings.limits} || ${JSON.stringify(set)}::jsonb) - ${sql.raw(`'{${unset.join(",")}}'::text[]`)}`,
          updatedAt: new Date(),
        },
      })
      .returning({ limits: schema.userSettings.limits });
    await u.db.insert(schema.adminEvents).values({ type: "user.limits_changed", actorId, userId, email: user.email, payload: { limits: row!.limits } });
    audit(svc, u, "user.limits_changed", actorId, userId);
    return { ok: true, overrides: row!.limits };
  });
}

const CREDENTIAL = "credential";

async function credentialAccount(u: UnitOfWork, userId: string) {
  const [row] = await u.db
    .select({ id: schema.account.id, password: schema.account.password })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, CREDENTIAL)))
    .for("update");
  return row ?? null;
}

async function dropSessions(u: UnitOfWork, userId: string, keepSessionId: string | undefined) {
  if (keepSessionId) {
    await u.db.delete(schema.session).where(and(eq(schema.session.userId, userId), ne(schema.session.id, keepSessionId)));
    return;
  }
  await u.db.delete(schema.session).where(eq(schema.session.userId, userId));
}

/**
 * Set the email/password hash (Better Auth's scrypt, same as sign-up). Operator CLI and the
 * must-change page both call this. `mustChange: true` blocks the app until they pick a different
 * password (no current-password field: the session already proved they knew the temporary one).
 * Other browser sessions end; API keys stay valid.
 */
export async function setUserPassword(
  svc: Services,
  actorId: string | null,
  userId: string,
  password: string,
  opts: { mustChange: boolean; keepSessionId?: string; rejectReuse?: boolean },
) {
  const length = passwordLengthError(password);
  if (length) throw new TRPCError({ code: "BAD_REQUEST", message: length });
  const hash = await hashPassword(password);
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    const cred = await credentialAccount(u, userId);
    if (opts.rejectReuse) {
      if (!user.mustChangePassword) throw new TRPCError({ code: "BAD_REQUEST", message: "This account does not need a new password." });
      if (cred?.password && (await verifyPassword({ hash: cred.password, password }))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: MUST_CHANGE_PASSWORD_REUSE });
      }
    }
    if (cred) await u.db.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(eq(schema.account.id, cred.id));
    else await u.db.insert(schema.account).values({ id: randomUUID(), accountId: userId, providerId: CREDENTIAL, userId, password: hash });
    await u.db.update(schema.user).set({ mustChangePassword: opts.mustChange, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await dropSessions(u, userId, opts.keepSessionId);
    await u.db.insert(schema.adminEvents).values({ type: "user.password_set", actorId, userId, email: user.email, payload: { mustChange: opts.mustChange } });
    audit(svc, u, "user.password_set", actorId, userId);
    return { ok: true as const };
  });
}
