/**
 * Account administration: approve, change role, suspend, remove. One function per transition,
 * each a unit of work that writes the user row and its admin event together and sends mail after
 * commit. tRPC (admin router) and the CLI call these; nothing else edits role/approval columns.
 */
import fs from "node:fs/promises";
import { and, eq, ne, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import type { UnitOfWork } from "./uow.js";
import { templates } from "./email.js";
import { listClips } from "./pipeline/analyze.js";
import { QUEUES } from "./queue/boss.js";
import { keys } from "./storage/index.js";
import type { UserRole } from "./db/schema.js";

const STAGE_QUEUES = [QUEUES.ingest, QUEUES.transcribe, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes, QUEUES.analyze] as const;

/** Delete a project with its jobs cancelled and its files removed after commit. Used by the owner and by user removal. */
export async function deleteProject(svc: Services, u: UnitOfWork, projectId: string) {
  for (const c of await listClips(u.db, projectId)) {
    await u.cancelLiveJobs(QUEUES.render, c.id);
    await u.cancelLiveJobs(QUEUES.prepare, c.id);
  }
  for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, projectId);
  await u.db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  u.afterCommit(async () => {
    await fs.rm(svc.paths.project(projectId), { recursive: true, force: true });
    await svc.storage.deletePrefix(keys.projectPrefix(projectId));
  });
}

async function lockedUser(u: UnitOfWork, id: string) {
  const [row] = await u.db.select().from(schema.user).where(eq(schema.user.id, id)).for("update");
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such user" });
  return row;
}

async function otherAdmins(u: UnitOfWork, exceptId: string) {
  const [{ n }] = await u.db.select({ n: sql<number>`count(*)::int` }).from(schema.user).where(and(eq(schema.user.role, "admin"), ne(schema.user.id, exceptId), eq(schema.user.banned, false)));
  return n;
}

export async function approveUser(svc: Services, actorId: string | null, userId: string) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    if (user.approvedAt) return { ok: true, changed: false };
    await u.db.update(schema.user).set({ approvedAt: new Date(), updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await u.db.insert(schema.adminEvents).values({ type: "user.approved", actorId, userId, email: user.email, payload: {} });
    u.afterCommit(() => svc.email.send({ to: user.email, ...templates.approved(svc.config.APP_URL) }));
    return { ok: true, changed: true };
  });
}

export async function setUserRole(svc: Services, actorId: string | null, userId: string, role: UserRole) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    if (user.role === role) return { ok: true, changed: false };
    if (role !== "admin" && userId === actorId) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot remove your own admin role. Ask another admin." });
    if (role !== "admin" && user.role === "admin" && (await otherAdmins(u, userId)) === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This is the only admin. Make someone else an admin first." });
    await u.db.update(schema.user).set({ role, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await u.db.insert(schema.adminEvents).values({ type: "user.role_changed", actorId, userId, email: user.email, payload: { from: user.role, to: role } });
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
    return { ok: true };
  });
}

export async function unbanUser(svc: Services, actorId: string, userId: string) {
  return svc.tx(async (u) => {
    const user = await lockedUser(u, userId);
    await u.db.update(schema.user).set({ banned: false, banReason: null, updatedAt: new Date() }).where(eq(schema.user.id, userId));
    await u.db.insert(schema.adminEvents).values({ type: "user.unbanned", actorId, userId, email: user.email, payload: {} });
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
    for (const p of projects) await deleteProject(svc, u, p.id);
    await u.db.delete(schema.user).where(eq(schema.user.id, userId)); // sessions, accounts, keys, uploads cascade
    await u.db.insert(schema.adminEvents).values({ type: "user.removed", actorId, userId, email: user.email, payload: { projects: projects.length } });
    return { ok: true, projects: projects.length };
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
        set: { limits: sql`(${schema.userSettings.limits} || ${JSON.stringify(set)}::jsonb) - ${sql.raw(`'{${unset.join(",")}}'::text[]`)}`, updatedAt: new Date() },
      })
      .returning({ limits: schema.userSettings.limits });
    await u.db.insert(schema.adminEvents).values({ type: "user.limits_changed", actorId, userId, email: user.email, payload: { limits: row!.limits } });
    return { ok: true, overrides: row!.limits };
  });
}
