/**
 * Palette / MCP search against a real Postgres (pg_trgm, migration 0028): typo tolerance, ranking,
 * AND across words, short words, LIKE escaping, tenant scope. Calls searchLibrary directly with the
 * test database; users are made through the running app like the other suites.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../src/db/index.js";
import { and, desc, inArray } from "drizzle-orm";
import { searchLibrary, setSearchThreshold, userMatch, userScore, words } from "../src/search.js";
import { db, signUp } from "./helpers.js";

describe("search", () => {
  const pool = db();
  const orm = drizzle(pool, { schema });
  let user: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  const ids = { budget: randomUUID(), savings: randomUUID(), misc: randomUUID(), theirs: randomUUID() };

  async function project(id: string, userId: string, title: string, updatedAt: string) {
    await pool.query(`insert into projects (id, user_id, title, source_type, source_url, duration_sec, status, settings, updated_at) values ($1, $2, $3, 'url', 'https://example.com/v.mp4', 61, 'done', '{}', $4)`, [id, userId, title, updatedAt]);
  }
  async function clip(projectId: string, index: number, title: string, hook = "", caption = "") {
    await pool.query(`insert into clips (id, project_id, index, title, hook, caption, start_sec, end_sec, score, reasoning, hashtags, status) values ($1, $2, $3, $4, $5, $6, 0, 10, 80, 'why', '[]', 'done')`, [randomUUID(), projectId, index, title, hook, caption]);
  }
  const search = (q: string, as = user.userId) => searchLibrary(orm, as, { q, limit: 15 });

  before(async () => {
    user = await signUp();
    other = await signUp();
    await project(ids.budget, user.userId, "Budgeting On A Low Income", "2026-01-01T00:00:00Z");
    await project(ids.savings, user.userId, "Savings plan for beginners", "2026-01-02T00:00:00Z");
    await project(ids.misc, user.userId, "Interview with a chef", "2026-01-03T00:00:00Z");
    await project(ids.theirs, other.userId, "Budgeting secrets", "2026-01-04T00:00:00Z");
    await clip(ids.budget, 0, "Track every dollar", "Know where it goes", "Spreadsheet basics");
    await clip(ids.budget, 1, "Cutting expenses", "Small cuts add up");
    await clip(ids.misc, 0, "100% sure it works", "Rate is 5_000 a month");
    await clip(ids.misc, 1, "Totally sure of it", "No percent here");
    await clip(ids.misc, 2, "The budget meeting", "A literal budget match");
    await clip(ids.misc, 3, "Budgeting tips", "Fuzzy only: budgting");
  });

  after(async () => {
    await pool.query(`delete from "user" where id = any($1)`, [[user?.userId, other?.userId].filter(Boolean)]);
    await pool.end();
  });

  it("finds a project through a typo", async () => {
    const r = await search("budgt");
    assert.ok(r.projects.some((p) => p.title.startsWith("Budgeting")), JSON.stringify(r.projects.map((p) => p.title)));
    const s = await search("savngs");
    assert.ok(s.projects.some((p) => p.title.startsWith("Savings")));
  });

  it("never returns another user's rows", async () => {
    const r = await search("budgeting");
    assert.ok(r.projects.every((p) => p.id !== ids.theirs));
  });

  it("ranks a literal match above a fuzzy one", async () => {
    const r = await search("budget");
    const literal = r.clips.findIndex((c) => c.title === "The budget meeting");
    const fuzzy = r.clips.findIndex((c) => c.title === "Budgeting tips");
    assert.ok(literal >= 0 && fuzzy >= 0, JSON.stringify(r.clips.map((c) => c.title)));
    assert.ok(literal < fuzzy);
    assert.ok(r.clips[literal]!.score > r.clips[fuzzy]!.score);
  });

  it("ANDs the words of a query", async () => {
    const both = await search("track dollar");
    assert.deepEqual(both.clips.map((c) => c.title), ["Track every dollar"]);
    const none = await search("track chef");
    assert.equal(none.clips.length, 0);
  });

  it("matches words under 3 characters literally only", async () => {
    const r = await search("tr");
    assert.ok(r.clips.some((c) => c.title === "Track every dollar"));
    assert.ok(!r.clips.some((c) => c.title === "Cutting expenses"));
    const typo = await search("bz");
    assert.equal(typo.clips.length + typo.projects.length, 0);
  });

  it("treats % and _ as plain characters", async () => {
    const pct = await search("100%");
    assert.deepEqual(pct.clips.map((c) => c.title), ["100% sure it works"]);
    const under = await search("5_000");
    assert.deepEqual(under.clips.map((c) => c.title), ["100% sure it works"]);
    const wild = await search("%");
    assert.deepEqual(wild.clips.map((c) => c.title), ["100% sure it works"]);
  });
});

describe("users search", () => {
  const pool = db();
  const orm = drizzle(pool, { schema });
  const tag = randomUUID().slice(0, 8);
  const made: string[] = [];
  async function mk(name: string, email: string) {
    const id = randomUUID();
    made.push(id);
    await pool.query(`insert into "user" (id, name, email, email_verified, role, banned) values ($1, $2, $3, true, 'user', false)`, [id, name, email]);
  }
  /** what admin.users.list runs for a search, restricted to the users made here */
  const find = (q: string) =>
    orm.transaction(async (tx) => {
      await setSearchThreshold(tx);
      const ws = words(q);
      const rows = await tx.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email }).from(schema.user).where(and(userMatch(ws), inArray(schema.user.id, made))).orderBy(desc(userScore(ws)!));
      return rows.map((r) => r.name);
    });

  before(async () => {
    await mk("Rosalind Franklin", `rosalind.${tag}@example.test`);
    await mk("Grace Hopper", `ghopper-${tag}@example.test`);
    await mk("Ada Lovelace", `bench-${tag}@example.test`);
  });
  after(async () => {
    await pool.query(`delete from "user" where id = any($1)`, [made]);
    await pool.end();
  });

  it("finds a name through a typo", async () => assert.deepEqual(await find("rosalnd"), ["Rosalind Franklin"]));
  it("matches part of an email, with punctuation", async () => {
    assert.deepEqual(await find(`bench-${tag.slice(0, 4)}`), ["Ada Lovelace"]);
    assert.deepEqual(await find("ghopper-"), ["Grace Hopper"]);
    assert.deepEqual(await find(`@example.test ${tag}`).then((n) => n.length), 3);
  });
  it("ANDs words across name and email", async () => {
    assert.deepEqual(await find(`grace ${tag}`), ["Grace Hopper"]);
    assert.deepEqual(await find("grace lovelace"), []);
  });
  it("ranks a literal match above a typo", async () => assert.equal((await find("grace"))[0], "Grace Hopper"));
});
