/**
 * Soft delete against the running app: a deleted project leaves the list and every route, comes back with
 * projects.restore; a re-analyze replaces only untouched AI picks and keeps what the user made or edited.
 * Run: node --import tsx --test test/soft-delete.test.ts   (needs `docker compose up` with this branch deployed)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, db, signUp } from "./helpers.js";

type U = Awaited<ReturnType<typeof signUp>>;
const json = { "content-type": "application/json", origin: BASE };

async function trpc(cookie: string, path: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url =
    method === "GET"
      ? `${BASE}/api/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`
      : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, { method, headers: { ...json, cookie }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string } } };
  return { status: res.status, data: body.result?.data, error: body.error };
}

describe("soft delete", () => {
  const pool = db();
  let owner: U;
  let other: U;
  const projectId = randomUUID();
  const clip = { untouched: randomUUID(), edited: randomUUID(), manual: randomUUID(), framed: randomUUID() };

  before(async () => {
    owner = await signUp();
    other = await signUp();
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, status, settings, duration_sec) values ($1, $2, 'Soft delete', 'url', 'https://example.com/v.mp4', 'done', '{}', 600)`,
      [projectId, owner.userId],
    );
    await pool.query(`insert into transcripts (project_id, text, words, segments) values ($1, 'hello', '[]', '[]')`, [projectId]);
    const add = (id: string, index: number, extra: string, values: unknown[] = []) =>
      pool.query(
        `insert into clips (id, project_id, index, title, hook, start_sec, end_sec, score, reasoning, hashtags, status${extra ? `, ${extra}` : ""}) values ($1, $2, $3, 'c', 'h', ${index * 60}, ${index * 60 + 30}, 70, 'r', '[]', 'done'${values.map((_, i) => `, $${i + 4}`).join("")})`,
        [id, projectId, index, ...values],
      );
    await add(clip.untouched, 0, "");
    await add(clip.edited, 1, "edited_at", [new Date()]);
    await add(clip.manual, 2, "origin", ["manual"]);
    await add(clip.framed, 3, "layout_override", ["fit"]);
  });

  after(async () => {
    await pool.query(`delete from projects where id = $1`, [projectId]);
    await pool.query(`delete from "user" where id = any($1)`, [[owner.userId, other.userId]]);
    await pool.end();
  });

  const listed = async (input?: unknown) =>
    ((await trpc(owner.cookie, "projects.list", input, "GET")).data as { items: Array<{ id: string }> }).items.map((p) => p.id);

  it("re-analyze replaces only untouched AI picks", async () => {
    const r = await trpc(owner.cookie, "projects.reanalyze", { id: projectId });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.deepEqual({ kept: (r.data as { kept: number }).kept, replaced: (r.data as { replaced: number }).replaced }, { kept: 3, replaced: 1 });
    const rows = await pool.query<{ id: string; deleted: boolean }>(`select id, deleted_at is not null as deleted from clips where project_id = $1`, [
      projectId,
    ]);
    const deleted = new Map(rows.rows.map((x) => [x.id, x.deleted]));
    assert.equal(deleted.get(clip.untouched), true);
    assert.equal(deleted.get(clip.edited), false);
    assert.equal(deleted.get(clip.manual), false);
    assert.equal(deleted.get(clip.framed), false);
    const ev = await pool.query(`select payload from project_events where project_id = $1 and type = 'stage.started' order by id desc limit 1`, [projectId]);
    assert.equal(ev.rows[0].payload.kept, 3);
    // the replaced clip is out of the project's clips, listed as restorable, and comes back
    const p = (await trpc(owner.cookie, "projects.get", { id: projectId }, "GET")).data as {
      clips: Array<{ id: string }>;
      replacedClips: Array<{ id: string }>;
    };
    assert.ok(!p.clips.some((c) => c.id === clip.untouched));
    assert.ok(p.replacedClips.some((c) => c.id === clip.untouched));
    assert.equal((await trpc(other.cookie, "clips.restore", { id: clip.untouched })).error?.data.code, "NOT_FOUND");
    const back = await trpc(owner.cookie, "clips.restore", { id: clip.untouched });
    assert.equal((back.data as { changed: boolean }).changed, true, JSON.stringify(back.error));
  });

  it("delete hides the project, restore brings it back", async () => {
    assert.ok((await listed()).includes(projectId));
    const del = await trpc(owner.cookie, "projects.delete", { id: projectId });
    assert.equal(del.status, 200, JSON.stringify(del.error));
    // work in progress (the re-analyze above) stopped; rows and files are kept
    const row = await pool.query(`select deleted_at is not null as deleted, status from projects where id = $1`, [projectId]);
    assert.deepEqual(row.rows[0], { deleted: true, status: "failed" });
    assert.ok(!(await listed()).includes(projectId));
    assert.ok((await listed({ deleted: true })).includes(projectId));
    assert.equal((await trpc(owner.cookie, "projects.get", { id: projectId }, "GET")).error?.data.code, "NOT_FOUND");
    assert.equal((await fetch(`${BASE}/api/projects/${projectId}/export.zip`, { headers: { cookie: owner.cookie } })).status, 404);
    // someone else can't restore it
    assert.equal((await trpc(other.cookie, "projects.restore", { id: projectId })).error?.data.code, "NOT_FOUND");
    const r = await trpc(owner.cookie, "projects.restore", { id: projectId });
    assert.equal((r.data as { changed: boolean }).changed, true, JSON.stringify(r.error));
    assert.ok((await listed()).includes(projectId));
    const types = (
      await pool.query(`select type from project_events where project_id = $1 and type in ('project.deleted', 'project.restored') order by id`, [projectId])
    ).rows.map((e) => e.type);
    assert.deepEqual(types, ["project.deleted", "project.restored"]);
  });
});
