/**
 * Failed-work list filters and bulk retry (lifecycle harness: Postgres + pg-boss, no running workers).
 * node --import tsx --test test/ops-failures.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import {
  clipFailureStage,
  dismissFailures,
  errorSnippet,
  getFailure,
  listFailures,
  retryFailures,
  retryQuotaRefusals,
  retryRefusedWork,
} from "../src/ops/failures.js";
import type { Services } from "../src/services.js";
import { NonRetryableError, SourceExpiredError, SourceUnavailableError, failedRow, failureCause } from "../src/pipeline/common.js";
import { QuotaExceededError } from "../src/quota.js";
import { QUEUES } from "../src/queue/boss.js";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";

describe("errorSnippet / clipFailureStage", () => {
  it("shortens a long reason and names an empty one", () => {
    assert.equal(errorSnippet(null), "Failed with no reason recorded");
    assert.equal(errorSnippet("disk was full"), "disk was full");
    assert.equal(errorSnippet("x".repeat(200)).length, 120);
    assert.ok(errorSnippet("x".repeat(200)).endsWith("…"));
  });
  it("treats an unprepared user clip as prepare, otherwise render", () => {
    assert.equal(clipFailureStage({ origin: "manual", reasoning: "", scores: null }), "prepare");
    assert.equal(clipFailureStage({ origin: "ai", reasoning: "hook", scores: {} }), "render");
  });
});

describe("failureCause / failedRow", () => {
  it("names a refusal quota, a source problem input, and anything else platform", () => {
    assert.equal(failureCause(new QuotaExceededError("This video is 57 minutes")), "quota");
    assert.equal(failureCause(new SourceUnavailableError("Could not download: the link no longer exists")), "input");
    assert.equal(failureCause(new NonRetryableError("Source has no audio track")), "input");
    assert.equal(failureCause(new Error("disk full")), "platform");
    // the project's Retry fetches an expired source again: not the source's fault
    assert.equal(failureCause(new SourceExpiredError(7)), "platform");
    assert.equal(failureCause(new NonRetryableError("No usable clips were found.", "platform")), "platform");
    assert.equal(failureCause("boom"), "platform");
  });
  it("writes the reason, the cause and clears an earlier dismissal", () => {
    const row = failedRow(new QuotaExceededError("too long"));
    assert.equal(row.status, "failed");
    assert.equal(row.error, "too long");
    assert.equal(row.failureCause, "quota");
    assert.equal(row.failureDismissedAt, null);
    assert.equal(failedRow("x", "input").failureCause, "input");
  });
});

const h = lifecycleHarness();
const notReady = await h.ready();

describe("listFailures / retryFailures", { skip: notReady ?? false }, () => {
  let userId: string;
  let email: string;
  before(async () => {
    userId = await h.makeUser();
    email = `${userId}@example.test`;
  });
  after(() => h.cleanup());

  async function failProject(stage: string, error: string, agoMs = 0, cause: string | null = null, owner = userId) {
    const id = await h.makeProject(owner, "failed");
    await h.pool.query(
      `update projects set stage = $2, error = $3, failure_cause = $5, updated_at = now() - ($4::bigint * interval '1 millisecond') where id = $1`,
      [id, stage, error, agoMs, cause],
    );
    return id;
  }
  async function failClip(projectStatus: string, error: string) {
    const projectId = await h.makeProject(userId, projectStatus);
    const clipId = await h.makeClip(projectId, 0, "failed");
    await h.pool.query(`update clips set error = $2, updated_at = now() where id = $1`, [clipId, error]);
    return { projectId, clipId };
  }

  it("filters by error substring and stage, and skips clips of a failed project", async () => {
    const disk = await failProject("render", "Disk was full; ffmpeg could not write");
    await failProject("ingest", "model down: connection refused");
    const { clipId } = await failClip("done", "encoder missing nvenc");
    const orphaned = await failClip("failed", "also disk"); // parent failed: clip must not appear

    const diskHits = await listFailures(h.svc, { q: "disk" });
    assert.ok(diskHits.items.some((i) => i.id === disk && i.kind === "project"));
    assert.ok(!diskHits.items.some((i) => i.id === orphaned.clipId));

    const renderHits = await listFailures(h.svc, { stage: "render" });
    assert.ok(renderHits.items.some((i) => i.id === disk));
    const clipRow = renderHits.items.find((i) => i.id === clipId && i.kind === "clip");
    assert.equal(clipRow?.title, "t");
    assert.equal(clipRow?.projectTitle, "lifecycle test");

    const one = await getFailure(h.svc, "clip", clipId);
    assert.equal(one?.id, clipId);
    assert.equal(one?.error, "encoder missing nvenc");
    assert.equal(await getFailure(h.svc, "clip", orphaned.clipId), null);

    const ingestHits = await listFailures(h.svc, { stage: "ingest" });
    assert.ok(ingestHits.items.every((i) => i.stage === "ingest"));
  });

  it("retries through lifecycle, caps the batch, and writes failures.retried", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await failProject("ingest", `disk full ${i}`));
    const page = await retryFailures(h.svc, { q: "disk full", stage: "ingest" }, { id: userId, email }, { limit: 2 });
    assert.equal(page.retried, 2);
    assert.ok(page.nextCursor);

    const jobs = await h.jobsFor(ids);
    assert.equal(jobs.filter((j) => j.name === QUEUES.ingest).length, 2);

    const ev = await h.pool.query(`select type, payload from events where type = 'failures.retried' and user_id = $1 order by id desc limit 1`, [userId]);
    assert.equal(ev.rows[0]?.type, "failures.retried");
    assert.equal((ev.rows[0]!.payload as { retried: number }).retried, 2);

    const rest = await retryFailures(h.svc, { q: "disk full", stage: "ingest" }, { id: userId, email });
    assert.equal(rest.retried, 1);
    assert.equal(await h.jobsFor(ids).then((j) => j.filter((x) => x.name === QUEUES.ingest).length), 3);
  });

  it("retries a failed clip on a done project via requestRender", async () => {
    const { projectId, clipId } = await failClip("done", "encoder missing");
    const r = await retryFailures(h.svc, {}, { id: userId, email }, { ids: [{ kind: "clip", id: clipId }] });
    assert.equal(r.retried, 1);
    const jobs = await h.jobsFor([clipId]);
    assert.ok(jobs.some((j) => j.name === QUEUES.render && j.singleton_key === clipId));
    const p = await h.pool.query(`select status from projects where id = $1`, [projectId]);
    assert.equal(p.rows[0].status, "rendering");
  });

  it("tells causes apart, and bulk retry by filter leaves input and quota failures alone", async () => {
    const tag = `cause-${Date.now()}`;
    const platform = await failProject("ingest", `${tag} disk full`);
    const input = await failProject("ingest", `${tag} no audio`, 0, "input");
    const quota = await failProject("ingest", `${tag} too long`, 0, "quota");

    const all = await listFailures(h.svc, { q: tag });
    const by = new Map(all.items.map((i) => [i.id, i]));
    assert.equal(by.get(platform)?.cause, "platform"); // a null cause (an old row) reads as platform
    assert.equal(by.get(platform)?.retryable, true);
    assert.equal(by.get(input)?.cause, "input");
    assert.equal(by.get(input)?.retryable, false);
    assert.equal(by.get(quota)?.cause, "quota");
    assert.deepEqual(
      (await listFailures(h.svc, { q: tag, cause: "input" })).items.map((i) => i.id),
      [input],
    );

    const r = await retryFailures(h.svc, { q: tag }, { id: userId, email });
    assert.equal(r.retried, 1);
    const jobs = await h.jobsFor([platform, input, quota]);
    assert.deepEqual(
      jobs.filter((j) => j.name === QUEUES.ingest).map((j) => j.singleton_key),
      [platform],
    );
  });

  it("dismisses failures from the list without touching the project, restores them, and a new failure shows again", async () => {
    const tag = `dismiss-${Date.now()}`;
    const a = await failProject("analyze", `${tag} no usable clips`, 0, "input");
    const b = await failProject("ingest", `${tag} gone`, 0, "input");

    const one = await dismissFailures(h.svc, {}, { id: userId, email }, { ids: [{ kind: "project", id: a }] });
    assert.equal(one.changed, 1);
    assert.deepEqual(
      (await listFailures(h.svc, { q: tag })).items.map((i) => i.id),
      [b],
    );
    assert.deepEqual(
      (await listFailures(h.svc, { q: tag, dismissed: true })).items.map((i) => i.id),
      [a],
    );
    const p = await h.pool.query(`select status, error from projects where id = $1`, [a]);
    assert.equal(p.rows[0].status, "failed");
    assert.equal(p.rows[0].error, `${tag} no usable clips`);
    assert.ok((await getFailure(h.svc, "project", a))?.dismissedAt);

    const rest = await dismissFailures(h.svc, { q: tag }, { id: userId, email });
    assert.equal(rest.changed, 1);
    assert.equal((await listFailures(h.svc, { q: tag })).total, 0);
    const ev = await h.pool.query(`select payload from events where type = 'failures.dismissed' and user_id = $1 order by id desc limit 1`, [userId]);
    assert.equal((ev.rows[0]!.payload as { changed: number }).changed, 1);

    const back = await dismissFailures(h.svc, { q: tag }, { id: userId, email }, { restore: true });
    assert.equal(back.changed, 2);
    assert.equal((await listFailures(h.svc, { q: tag })).total, 2);

    await dismissFailures(h.svc, { q: tag }, { id: userId, email });
    await h.pool.query(`update projects set status = 'ingesting' where id = $1`, [a]);
    await h.tx((u) =>
      u.db
        .update(schema.projects)
        .set(failedRow(new Error(`${tag} disk full`)))
        .where(eq(schema.projects.id, a)),
    );
    const again = await listFailures(h.svc, { q: tag });
    assert.deepEqual(
      again.items.map((i) => [i.id, i.cause]),
      [[a, "platform"]],
    );
  });

  it("retries an owner's recent plan refusals after a plan or limits change, and nothing else", async () => {
    const owner = await h.makeUser();
    const tag = `quota-${Date.now()}`;
    const recent = await failProject("ingest", `${tag} too long`, 0, "quota", owner);
    const old = await failProject("ingest", `${tag} too long`, 40 * 86_400_000, "quota", owner);
    const other = await failProject("ingest", `${tag} gone`, 0, "input", owner);
    const r = await retryQuotaRefusals(h.svc, owner);
    assert.equal(r.retried, 1);
    const jobs = await h.jobsFor([recent, old, other]);
    assert.deepEqual(
      jobs.filter((j) => j.name === QUEUES.ingest).map((j) => j.singleton_key),
      [recent],
    );
    assert.equal((await retryQuotaRefusals(h.svc, owner)).retried, 0);
  });

  it("follows a plan or limits change: only for the minutes limits, and not when nothing would fit", async () => {
    const owner = await h.makeUser();
    const tag = `handler-${Date.now()}`;
    const refused = await failProject("ingest", `${tag} too long`, 0, "quota", owner);
    const handler = retryRefusedWork<"user.limits_changed">();
    const event = (changed: string[]) => ({
      id: 1,
      type: "user.limits_changed" as const,
      actorId: null,
      payload: { userId: owner, email: `${owner}@example.test`, limits: {}, changed },
    });
    const keyOf = (changed: string[]) => handler.key!({ event: event(changed), db: h.svc.database.db, deps: h.svc as Pick<Services, "email" | "settings"> });
    assert.equal(await keyOf(["MAX_STORAGE_MB"]), null);
    assert.equal(await keyOf(["MAX_SOURCE_MINUTES_PER_MONTH"]), `quota-retry:${owner}`);
    assert.equal(
      await retryRefusedWork<"user.limits_changed">().key!({ event: event(["MAX_SOURCE_MINUTES_PER_DAY"]), db: h.svc.database.db, deps: h.svc as never }),
      `quota-retry:${owner}`,
    );

    // a day cap already used up: even a minute would be refused, so nothing is fetched again
    await h.pool.query(`insert into user_settings (user_id, limits) values ($1, '{"MAX_SOURCE_MINUTES_PER_DAY": 10}'::jsonb)`, [owner]);
    const used = await h.makeProject(owner, "done");
    await h.pool.query(`insert into source_usage (user_id, project_id, created_at, duration_sec) values ($1, $2, now(), 6000)`, [owner, used]);
    await handler.handle({ event: event(["MAX_SOURCE_MINUTES_PER_DAY"]), key: `quota-retry:${owner}`, svc: h.svc, signal: new AbortController().signal });
    assert.equal((await h.pool.query(`select status from projects where id = $1`, [refused])).rows[0].status, "failed");

    // the cap raised: the refusal resumes
    await h.pool.query(`update user_settings set limits = '{"MAX_SOURCE_MINUTES_PER_DAY": 1000}'::jsonb where user_id = $1`, [owner]);
    await handler.handle({ event: event(["MAX_SOURCE_MINUTES_PER_DAY"]), key: `quota-retry:${owner}`, svc: h.svc, signal: new AbortController().signal });
    assert.notEqual((await h.pool.query(`select status from projects where id = $1`, [refused])).rows[0].status, "failed");
  });

  it("retries a failed clip of a project whose source expired through the project, which fetches it again", async () => {
    const projectId = await h.makeProject(userId, "done");
    await h.pool.query(`update projects set source_expired_at = now() where id = $1`, [projectId]);
    const clipId = await h.makeClip(projectId, 0, "failed");
    await h.pool.query(`update clips set error = 'source removed', failure_cause = 'platform' where id = $1`, [clipId]);
    const r = await retryFailures(h.svc, {}, { id: userId, email }, { ids: [{ kind: "clip", id: clipId }] });
    assert.equal(r.retried, 1);
    const jobs = await h.jobsFor([projectId, clipId]);
    assert.ok(jobs.some((j) => j.name === QUEUES.ingest && j.singleton_key === projectId));
  });

  it("starts one run when two retries of the same failed project race", async () => {
    const id = await failProject("ingest", `race-${Date.now()}`);
    const [a, b] = await Promise.all([
      retryFailures(h.svc, {}, null, { ids: [{ kind: "project", id }] }),
      retryFailures(h.svc, {}, null, { ids: [{ kind: "project", id }] }),
    ]);
    assert.equal(a.retried + b.retried, 1);
    assert.equal((await h.pool.query(`select run_seq from projects where id = $1`, [id])).rows[0].run_seq, 2);
  });

  it("writes no audit event when a dismiss changes nothing", async () => {
    const before = (await h.pool.query(`select count(*)::int as n from events where type = 'failures.dismissed'`)).rows[0].n;
    const r = await dismissFailures(h.svc, { q: `nothing-matches-${Date.now()}` }, { id: userId, email });
    assert.equal(r.changed, 0);
    assert.equal((await h.pool.query(`select count(*)::int as n from events where type = 'failures.dismissed'`)).rows[0].n, before);
  });
});
