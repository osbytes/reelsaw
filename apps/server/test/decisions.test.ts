/**
 * The decision log against the running app (docs/specs/decision-log.md): each action writes one row per decided item
 * in its own transaction, with context to judge it later; learning off records nothing; "Delete forever" keeps the
 * rows unless asked to forget; forget removes them.
 * Run: node --import tsx --test test/decisions.test.ts   (needs `docker compose up` with this branch deployed)
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

const words = Array.from({ length: 80 }, (_, i) => ({ text: i === 40 || i === 41 ? "the" : `w${i}`, start: i, end: i + 0.8 }));
const flag = (id: string, wordIndex: number, o: Record<string, unknown> = {}) => ({
  id,
  kind: "disfluency",
  subkind: "repetition",
  wordIndex,
  span: 1,
  start: wordIndex,
  end: wordIndex + 0.8,
  heard: words[wordIndex]!.text,
  suggested: "",
  confidence: 0.6,
  status: "pending",
  ...o,
});

describe("decision log", () => {
  const pool = db();
  let owner: U;
  const projectId = randomUUID();
  const clipId = randomUUID();
  const replacedId = randomUUID();

  const rows = async (kind?: string) =>
    (
      await pool.query<{
        kind: string;
        explicit: boolean;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        context: Record<string, unknown>;
        source: Record<string, unknown>;
        clip_id: string | null;
      }>(
        `select kind, explicit, before, after, context, source, clip_id from user_decisions where project_id = $1${kind ? " and kind = $2" : ""} order by id`,
        kind ? [projectId, kind] : [projectId],
      )
    ).rows;

  before(async () => {
    owner = await signUp();
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, source_meta, status, settings, duration_sec) values ($1, $2, 'Decisions', 'url', 'https://www.youtube.com/watch?v=abc', $3, 'done', '{}', 600)`,
      [
        projectId,
        owner.userId,
        JSON.stringify({ webpage_url: "https://www.youtube.com/watch?v=abc", videoId: "abc", extractor: "Youtube", sha256: "ab".repeat(32) }),
      ],
    );
    await pool.query(`insert into transcripts (project_id, text, words, raw_words, segments, flags) values ($1, 'x', $2, $2, $3, $4)`, [
      projectId,
      JSON.stringify(words),
      JSON.stringify([{ text: words.map((w) => w.text).join(" "), start: 0, end: 80 }]),
      JSON.stringify([flag("accept-me", 41), flag("reject-me", 10), flag("delete-me", 60, { status: "auto" })]),
    ]);
    const clip = (id: string, index: number, extra = "") =>
      pool.query(
        `insert into clips (id, project_id, index, title, hook, start_sec, end_sec, score, reasoning, hashtags, status${extra ? ", edited_at" : ""}) values ($1, $2, $3, 'AI title', 'AI hook', ${index * 30}, ${index * 30 + 25}, 72, 'because', '[]', 'done'${extra ? ", now()" : ""})`,
        [id, projectId, index],
      );
    await clip(clipId, 0);
    await clip(replacedId, 1);
  });

  after(async () => {
    await pool.query(`delete from projects where id = $1`, [projectId]);
    await pool.query(`delete from "user" where id = $1`, [owner.userId]);
    await pool.end();
  });

  it("records accepts and rejects with the word window and the source", async () => {
    const r = await trpc(owner.cookie, "transcripts.review", {
      projectId,
      decisions: [
        { id: "accept-me", status: "accepted" },
        { id: "reject-me", status: "rejected" },
      ],
      rerender: false,
    });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    const [a] = await rows("fix.accept");
    const [j] = await rows("fix.reject");
    assert.ok(a && j);
    assert.equal(a.before?.status, "pending");
    assert.equal(a.after?.status, "accepted");
    assert.equal(a.context.flagKind, "disfluency");
    assert.deepEqual(a.context.target, { index: 30, span: 1 });
    assert.equal((a.context.words as unknown[]).length, 61);
    assert.equal(a.source.videoId, "abc");
    assert.equal(a.source.sha256, "ab".repeat(32));
    // deciding the same thing again changes nothing and records nothing
    await trpc(owner.cookie, "transcripts.review", { projectId, decisions: [{ id: "accept-me", status: "accepted" }], rerender: false });
    assert.equal((await rows("fix.accept")).length, 1);
  });

  it("records manual cuts and deletes; a refused action records nothing", async () => {
    const cut = await trpc(owner.cookie, "transcripts.addCut", { projectId, start: 20, end: 21.8, rerender: false });
    assert.equal(cut.status, 200, JSON.stringify(cut.error));
    const [m] = await rows("fix.manual");
    assert.equal(m?.after?.subkind, "manual");
    const bad = await trpc(owner.cookie, "transcripts.addCut", { projectId, start: 500, end: 501, rerender: false });
    assert.equal(bad.status, 400);
    assert.equal((await rows("fix.manual")).length, 1);
    const del = await trpc(owner.cookie, "transcripts.deleteFlag", { projectId, flagId: "delete-me", rerender: false });
    assert.equal(del.status, 200, JSON.stringify(del.error));
    const [d] = await rows("fix.delete");
    assert.equal(d?.before?.status, "auto");
  });

  it("a manual cut over the detector's unreviewed cut records an inferred accept", async () => {
    const other = randomUUID();
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, status, settings) values ($1, $2, 'Absorb', 'url', 'https://example.com/v.mp4', 'done', '{}')`,
      [other, owner.userId],
    );
    await pool.query(`insert into transcripts (project_id, text, words, raw_words, segments, flags) values ($1, 'x', $2, $2, '[]', $3)`, [
      other,
      JSON.stringify(words),
      JSON.stringify([flag("absorb-me", 70)]),
    ]);
    const cut = await trpc(owner.cookie, "transcripts.addCut", { projectId: other, start: 69, end: 71.8, rerender: false });
    assert.equal(cut.status, 200, JSON.stringify(cut.error));
    const kinds = (
      await pool.query<{ kind: string; flag: string; explicit: boolean }>(
        `select kind, explicit, context->>'flagId' as flag from user_decisions where project_id = $1 order by id`,
        [other],
      )
    ).rows;
    assert.deepEqual(
      kinds.map((r) => r.kind),
      ["fix.accept", "fix.manual"],
    );
    assert.equal(kinds[0]!.flag, "absorb-me");
    assert.deepEqual(
      kinds.map((r) => r.explicit),
      [false, true],
    );
    await pool.query(`delete from user_decisions where project_id = $1`, [other]);
    await pool.query(`delete from projects where id = $1`, [other]);
  });

  it("records a clip edit as the changed fields before and after", async () => {
    const r = await trpc(owner.cookie, "clips.update", { id: clipId, title: "My title", startSec: 2, rerender: false });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    const [e] = await rows("clip.edit");
    assert.equal(e?.clip_id, clipId);
    assert.deepEqual(e?.before, { title: "AI title", startSec: 0, endSec: 25 });
    assert.deepEqual(e?.after, { title: "My title", startSec: 2, endSec: 25 });
    assert.equal(e?.context.reasoning, "because");
    assert.ok(String(e?.context.text).includes("w3"));
  });

  it("records a re-analyze's replaced picks as inferred, and a delete as explicit", async () => {
    const r = await trpc(owner.cookie, "projects.reanalyze", { id: projectId });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    const [rep] = await rows("clip.replaced");
    assert.equal(rep?.clip_id, replacedId);
    assert.equal(rep?.explicit, false);
    assert.equal(rep?.before?.title, "AI title");
    const del = await trpc(owner.cookie, "clips.delete", { id: clipId });
    assert.equal(del.status, 200, JSON.stringify(del.error));
    const [d] = await rows("clip.delete");
    assert.equal(d?.explicit, true);
    assert.equal(d?.before?.title, "My title");
  });

  it("records nothing while learning is off", async () => {
    const before = (await rows()).length;
    await trpc(owner.cookie, "decisions.setLearning", { enabled: false });
    await trpc(owner.cookie, "clips.restore", { id: clipId });
    assert.equal((await rows()).length, before);
    const s = (await trpc(owner.cookie, "decisions.summary", undefined, "GET")).data as { enabled: boolean; total: number; byKind: Record<string, number> };
    assert.equal(s.enabled, false);
    assert.equal(s.total, before);
    await trpc(owner.cookie, "decisions.setLearning", { enabled: true });
  });

  it("lists and exports a user's decisions, with eval cases", async () => {
    const page = (await trpc(owner.cookie, "decisions.list", { kind: "fix.reject" }, "GET")).data as { items: Array<{ kind: string }>; total: number };
    assert.equal(page.total, 1);
    const ex = (await trpc(owner.cookie, "decisions.export", {}, "GET")).data as {
      items: Array<{ id: number }>;
      cases: { disfluency: Array<{ expect: string }> };
    };
    assert.ok(ex.items.length >= 6);
    assert.deepEqual(ex.cases.disfluency.map((c) => c.expect).sort(), ["cut", "cut", "keep", "keep"]);
  });

  it("a delete that asked to forget hides the decisions from learning, a restore takes it back, the purge honours it", async () => {
    const n = (await rows()).length;
    const exported = async () =>
      ((await trpc(owner.cookie, "decisions.export", {}, "GET")).data as { items: Array<{ projectId: string }> }).items.filter((d) => d.projectId === projectId)
        .length;
    assert.equal((await trpc(owner.cookie, "projects.delete", { id: projectId, forgetDecisions: true })).status, 200);
    assert.equal(await exported(), 0);
    assert.equal((await rows()).length, n); // kept until the purge, so a restore loses nothing
    const listed = (await trpc(owner.cookie, "deleted.list", undefined, "GET")).data as { items: Array<{ id: string; forgetDecisions?: boolean }> };
    assert.equal(listed.items.find((i) => i.id === projectId)?.forgetDecisions, true);
    assert.equal((await trpc(owner.cookie, "projects.restore", { id: projectId })).status, 200);
    assert.equal(await exported(), n);
    assert.equal((await pool.query(`select forget_decisions_on_purge as f from projects where id = $1`, [projectId])).rows[0].f, false);
  });

  it("a purge without the option (the toast, the retention sweep) still forgets a project deleted with it", async () => {
    const other = randomUUID();
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, status, settings) values ($1, $2, 'Other', 'url', 'https://example.com/v.mp4', 'done', '{}')`,
      [other, owner.userId],
    );
    await pool.query(
      `insert into user_decisions (user_id, project_id, kind, explicit, context, source, app_version) values ($1, $2, 'fix.reject', true, '{}', '{"type":"url"}', 'test')`,
      [owner.userId, other],
    );
    assert.equal((await trpc(owner.cookie, "projects.delete", { id: other, forgetDecisions: true })).status, 200);
    const purge = await trpc(owner.cookie, "projects.purge", { id: other });
    assert.equal((purge.data as { forgottenDecisions: number }).forgottenDecisions, 1, JSON.stringify(purge.error));
    assert.equal((await pool.query(`select 1 from user_decisions where project_id = $1`, [other])).rowCount, 0);
  });

  it("keeps decisions after Delete forever, and forgets them when asked", async () => {
    const n = (await rows()).length;
    assert.equal((await trpc(owner.cookie, "projects.delete", { id: projectId })).status, 200);
    const purge = await trpc(owner.cookie, "projects.purge", { id: projectId });
    assert.equal(purge.status, 200, JSON.stringify(purge.error));
    assert.equal((await pool.query(`select 1 from projects where id = $1`, [projectId])).rowCount, 0);
    assert.equal((await rows()).length, n);
    const forget = await trpc(owner.cookie, "decisions.forget", { projectId });
    assert.equal((forget.data as { forgotten: number }).forgotten, n);
    assert.equal((await rows()).length, 0);
  });
});
