/**
 * Account administration: approve, change role, suspend, remove, set password. One function per
 * transition, each a unit of work that writes the user row and its event (`u.emit`)
 * together; mail that follows is a handler on the event (notify/account.ts). tRPC (admin router) and the CLI call these; nothing else edits role/approval
 * columns or the credential hash.
 */
import { and, asc, eq, gt, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { MUST_CHANGE_PASSWORD_REUSE, passwordLengthError } from "@reelsaw/shared";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import type { UnitOfWork } from "./uow.js";
import { purgeProject } from "./projects/service.js";
import type { UserRole } from "./db/schema.js";
import { statusOf, userFilterWhere } from "./accounts-list.js";
import { BULK_USERS, type BulkUserAction, type BulkUsersInput, type UserStatus } from "./accounts-schema.js";
import { setSearchThreshold, userMatch, words } from "./search.js";

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
    await u.emit("user.approved", { userId, email: user.email }, { actorId });
    // how long sign-ups wait for an admin (SIGNUP_MODE=approval); the approved account is the distinct id
    u.afterCommit(() => svc.telemetry.capture("user.approved", userId, { waitHours: Math.round((Date.now() - user.createdAt.getTime()) / 360_000) / 10 }));
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
    await u.emit("user.role_changed", { userId, email: user.email, from: user.role, to: role }, { actorId });
    return { ok: true, changed: true };
  });
}

export async function banUser(svc: Services, actorId: string | null, userId: string, reason: string | null) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    if (userId === actorId) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot suspend yourself." });
    if (user.role === "admin" && (await otherAdmins(u, userId)) === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This is the only admin." });
    await u.db.update(schema.user).set({ banned: true, banReason: reason, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    // their browser sessions end now; API keys fail at the next request (requester reads the row)
    await u.db.delete(schema.session).where(eq(schema.session.userId, userId));
    await u.emit("user.banned", { userId, email: user.email, reason }, { actorId });
    return { ok: true };
  });
}

export async function unbanUser(svc: Services, actorId: string | null, userId: string) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    await u.db.update(schema.user).set({ banned: false, banReason: null, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await u.emit("user.unbanned", { userId, email: user.email }, { actorId });
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
    // hosted: the Stripe subscription must stop billing too. Read what to cancel before the rows cascade away;
    // the cancel is a handler on the `billing.detached` event this commits (ee/event-handlers.ts)
    if (svc.ee) await svc.ee.billing.detachUser(u, userId, user.email);
    // removing an account is final: its projects (deleted ones included) go now, not after the restore window
    for (const p of projects) await purgeProject(svc, u, p.id);
    await u.db.delete(schema.user).where(eq(schema.user.id, userId)); // sessions, accounts, keys, uploads cascade
    await u.db.delete(schema.sourceUsage).where(eq(schema.sourceUsage.userId, userId)); // no FK: it outlives project purges, not the account
    // its projects' history outlives a purge (like its decisions), not the account; its account events stay as the record
    await u.db.delete(schema.events).where(and(eq(schema.events.userId, userId), isNotNull(schema.events.projectId)));
    await u.emit("user.removed", { userId, email: user.email, projects: projects.length }, { actorId });
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
    await u.emit("user.watermark_changed", { userId, email: user.email, watermark }, { actorId });
    return { ok: true, watermark };
  });
}

/**
 * Per-user quota overrides (null = back to the instance setting). One statement merges the
 * patch into the jsonb (no read-modify-write), and the event commits with it.
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
    await u.emit("user.limits_changed", { userId, email: user.email, limits: row!.limits }, { actorId });
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
    await u.emit("user.password_set", { userId, email: user.email, mustChange: opts.mustChange }, { actorId });
    return { ok: true as const };
  });
}

/** Which accounts each action can change; the others are left as they are (not an error). */
const APPLIES: Record<BulkUserAction, (s: UserStatus) => boolean> = {
  approve: (s) => s === "pending",
  suspend: (s) => s !== "suspended",
  reinstate: (s) => s === "suspended",
  delete: () => true,
};
const APPLIES_SQL: Record<BulkUserAction, SQL | undefined> = {
  approve: sql`${schema.user.approvedAt} is null and not ${schema.user.banned}`,
  suspend: sql`not ${schema.user.banned}`,
  reinstate: sql`${schema.user.banned}`,
  delete: undefined,
};

/**
 * One action over many accounts: the listed `ids`, or a page of every account matching `filter` (the Users
 * page's "select all matching"), walked in id order with `cursor` so a run over thousands always moves
 * forward, whatever the action does to the filter. Each account goes through its own transition above, in
 * its own unit of work, with its own event: the guards (yourself, the last admin) hold per account and a
 * refusal skips that one with its reason instead of failing the rest.
 */
export async function bulkUsers(svc: Services, actorId: string | null, input: BulkUsersInput) {
  const db = svc.database.db;
  const U = schema.user;
  const cols = { id: U.id, email: U.email, banned: U.banned, approvedAt: U.approvedAt };
  let rows: Array<{ id: string; email: string; banned: boolean; approvedAt: Date | null }>;
  let nextCursor: string | null = null;
  if (input.ids) {
    const found = await db.select(cols).from(U).where(inArray(U.id, input.ids));
    const byId = new Map(found.map((r) => [r.id, r]));
    rows = input.ids.flatMap((id) => byId.get(id) ?? []);
  } else {
    const f = input.filter ?? {};
    const fetched = await db.transaction(async (tx) => {
      await setSearchThreshold(tx);
      return tx
        .select(cols)
        .from(U)
        .where(and(userMatch(words(f.q ?? "")), userFilterWhere(f), APPLIES_SQL[input.action], input.cursor ? gt(U.id, input.cursor) : undefined))
        .orderBy(asc(U.id))
        .limit(BULK_USERS + 1);
    });
    rows = fetched.slice(0, BULK_USERS);
    nextCursor = fetched.length > BULK_USERS ? rows[rows.length - 1]!.id : null;
  }
  const missing = input.ids ? input.ids.length - rows.length : 0;
  let changed = 0;
  let unchanged = missing;
  const skipped: Array<{ id: string; email: string; reason: string }> = [];
  const reason = input.reason?.trim() || null;
  const log = svc.log.child({ module: "accounts" });
  for (const r of rows) {
    if (!APPLIES[input.action](statusOf(r))) {
      unchanged++;
      continue;
    }
    try {
      if (input.action === "approve") {
        if ((await approveUser(svc, actorId, r.id)).changed) changed++;
        else unchanged++;
      } else if (input.action === "suspend") {
        await banUser(svc, actorId, r.id, reason);
        changed++;
      } else if (input.action === "reinstate") {
        await unbanUser(svc, actorId, r.id);
        changed++;
      } else {
        await removeUser(svc, actorId, r.id);
        changed++;
      }
    } catch (err) {
      // a guard (yourself, the last admin) or a row removed meanwhile: skip it, say why, go on
      const message = err instanceof TRPCError ? err.message : "Something went wrong";
      if (!(err instanceof TRPCError)) log.warn({ err, userId: r.id, action: input.action }, "bulk account action skipped");
      skipped.push({ id: r.id, email: r.email, reason: message });
    }
  }
  return { action: input.action, changed, unchanged, skipped, nextCursor };
}
