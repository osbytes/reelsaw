/**
 * Webhook delivery and share-link rules that need the database: a delivery that throws is retried on the schedule and
 * then given up, a failed test never turns an endpoint off, a new URL starts a clean failure record, a rotation is not
 * cut short, and share links are reused (also for short instance ceilings and concurrent callers) and listed newest
 * first. Needs Postgres only (lifecycle-harness.ts).
 * node --import tsx --test test/webhooks-delivery.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createSecretBox } from "../src/ai/crypto.js";
import type { PublicResponse } from "../src/lib/safe-url.js";
import { deliverOnce, MAX_ATTEMPTS, recordSendError, requeueStuckDeliveries, testEndpoint } from "../src/webhooks/deliver.js";
import { rotateSecret, updateEndpoint } from "../src/webhooks/service.js";
import { getOrCreateLink, listLinks } from "../src/media-links/service.js";
import { lifecycleHarness } from "./lifecycle-harness.js";

const h = lifecycleHarness();
const notReady = await h.ready();

const AUTH_SECRET = randomBytes(32).toString("hex");
Object.assign(h.svc.config, { BETTER_AUTH_SECRET: AUTH_SECRET, APP_URL: "http://localhost:3000" });
Object.assign(h.svc.settings.get(), { ALLOW_PRIVATE_WEBHOOK_URLS: true, MEDIA_LINK_TTL_DAYS: 90, MEDIA_LINK_ALLOW_NEVER: true });
Object.assign(h.svc, { email: { send: async () => {} } });

const answer = (status: number): PublicResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  body: { cancel: async () => {}, getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
});
const fails = async () => answer(500);

after(() => h.cleanup());

describe("webhook delivery", { skip: notReady ?? false }, () => {
  let owner: string;
  const endpoints: string[] = [];
  const endpoint = async (over: { failingSince?: Date } = {}) => {
    const id = `whk_t${randomUUID().slice(0, 8)}`;
    endpoints.push(id);
    const sealed = createSecretBox(AUTH_SECRET, "webhooks").encrypt(`whsec_${randomBytes(24).toString("base64")}`);
    await h.pool.query(
      `insert into webhook_endpoints (id, user_id, url, events, secret_sealed, failing_since) values ($1, $2, 'http://127.0.0.1:9/hook', '{project.done}', $3, $4)`,
      [id, owner, sealed, over.failingSince ?? null],
    );
    return id;
  };
  const delivery = async (endpointId: string, over: { status?: string; attempt?: number } = {}) =>
    Number(
      (
        await h.pool.query(
          `insert into webhook_deliveries (endpoint_id, user_id, type, status, attempt, next_attempt_at, body) values ($1, $2, 'project.done', $3, $4, now(), '{}') returning id`,
          [endpointId, owner, over.status ?? "pending", over.attempt ?? 0],
        )
      ).rows[0].id,
    );
  const row = async (id: number) =>
    (await h.pool.query(`select status, attempt, last_error, next_attempt_at from webhook_deliveries where id = $1`, [id])).rows[0];

  before(async () => {
    owner = await h.makeUser();
  });
  after(async () => {
    // the retries were queued for real; drop them before a running app's worker tries a fake endpoint
    await h.pool.query(
      `delete from pgboss.job where name = 'webhooks.deliver' and (data->>'deliveryId')::bigint in (select id from webhook_deliveries where endpoint_id = any($1))`,
      [endpoints],
    );
  });

  it("an attempt that threw is retried on the schedule, then given up", async () => {
    const e = await endpoint();
    const early = await delivery(e, { status: "sending", attempt: 1 });
    await recordSendError(h.svc, early, new Error("cannot decrypt"));
    const r1 = await row(early);
    assert.equal(r1.status, "pending");
    assert.match(r1.last_error, /could not send this delivery: cannot decrypt/);
    assert.ok(new Date(r1.next_attempt_at).getTime() > Date.now() + 20_000, "waits the first backoff");

    const last = await delivery(e, { status: "sending", attempt: MAX_ATTEMPTS });
    await recordSendError(h.svc, last, new Error("still broken"));
    assert.equal((await row(last)).status, "failed");

    // the sweep requeued one past the last attempt: the claim gives it up instead of sending
    const swept = await delivery(e, { attempt: MAX_ATTEMPTS });
    let sent = 0;
    const out = await deliverOnce(h.svc, swept, { fetch: async () => (sent++, answer(200)) });
    assert.equal(out?.status, "failed");
    assert.equal(sent, 0);
  });

  it("a failed test never turns an endpoint off, however long it has failed", async () => {
    const e = await endpoint({ failingSince: new Date(Date.now() - 4 * 86_400_000) });
    for (let i = 0; i < 6; i++) await h.pool.query(`update webhook_deliveries set last_error = 'x', status = 'failed' where id = $1`, [await delivery(e)]);
    const r = await testEndpoint(h.svc, owner, e, { fetch: fails });
    assert.equal(r.ok, false);
    const ep = (await h.pool.query(`select enabled, disabled_reason from webhook_endpoints where id = $1`, [e])).rows[0];
    assert.deepEqual(ep, { enabled: true, disabled_reason: null });
  });

  it("the disable rule reads the injected clock", async () => {
    const e = await endpoint({ failingSince: new Date() });
    for (let i = 0; i < 5; i++) await h.pool.query(`update webhook_deliveries set last_error = 'x', status = 'failed' where id = $1`, [await delivery(e)]);
    const d = await delivery(e);
    await deliverOnce(h.svc, d, { fetch: fails, now: () => new Date(Date.now() + 4 * 86_400_000) });
    assert.equal((await h.pool.query(`select enabled from webhook_endpoints where id = $1`, [e])).rows[0].enabled, false);
  });

  it("a new URL starts with a clean failure record", async () => {
    const e = await endpoint({ failingSince: new Date(Date.now() - 2 * 86_400_000) });
    const r = await updateEndpoint(h.svc, owner, e, { url: "http://127.0.0.1:10/hook" });
    assert.deepEqual(r.changed, ["url"]);
    assert.equal(r.endpoint.failingSince, null);
    assert.equal(r.endpoint.status, "active");
  });

  it("the sweep resets a lost delivery together with its job, and fails a lost test", async () => {
    const e = await endpoint();
    const lost = await delivery(e, { status: "sending", attempt: 1 });
    const test = Number(
      (
        await h.pool.query(
          `insert into webhook_deliveries (endpoint_id, user_id, type, status, attempt, next_attempt_at) values ($1, $2, 'webhook.test', 'pending', 0, now()) returning id`,
          [e, owner],
        )
      ).rows[0].id,
    );
    await h.pool.query(`update webhook_deliveries set next_attempt_at = now() - interval '10 minutes' where id = any($1)`, [[lost, test]]);
    await requeueStuckDeliveries(h.svc);
    assert.equal((await row(lost)).status, "pending");
    const jobs = await h.pool.query(`select 1 from pgboss.job where name = 'webhooks.deliver' and (data->>'deliveryId')::bigint = $1`, [lost]);
    assert.equal(jobs.rowCount, 1);
    const t = await row(test);
    assert.equal(t.status, "failed");
    assert.match(t.last_error, /interrupted/);
  });

  it("two rotations at once: one wins, the other is refused", async () => {
    const e = await endpoint();
    const results = await Promise.allSettled([rotateSecret(h.svc, owner, e), rotateSecret(h.svc, owner, e)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const won = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ secret: string }>;
    const stored = (await h.pool.query(`select secret_sealed from webhook_endpoints where id = $1`, [e])).rows[0].secret_sealed;
    assert.equal(createSecretBox(AUTH_SECRET, "webhooks").decrypt(stored), won.value.secret);
  });

  it("a second rotation inside the overlap is refused", async () => {
    const e = await endpoint();
    await rotateSecret(h.svc, owner, e);
    await assert.rejects(rotateSecret(h.svc, owner, e), /rotation is already under way/);
  });
});

describe("share links", { skip: notReady ?? false }, () => {
  let owner: string;
  let clipId: string;
  before(async () => {
    owner = await h.makeUser();
    const projectId = await h.makeProject(owner, "done");
    clipId = await h.makeClip(projectId, 0, "done", { outputKey: "clips/x.mp4" });
  });

  it("concurrent requests for one clip agree on one link", async () => {
    const links = await Promise.all([1, 2, 3].map(() => getOrCreateLink(h.svc, owner, { kind: "clip", clipId }, { source: "webhook" })));
    assert.equal(new Set(links.map((l) => l.id)).size, 1);
  });

  it("links are reused where the instance ceiling is a week or less", async () => {
    const settings = h.svc.settings.get() as { MEDIA_LINK_TTL_DAYS: number };
    settings.MEDIA_LINK_TTL_DAYS = 3;
    try {
      const a = await getOrCreateLink(h.svc, owner, { kind: "clip", clipId }, { source: "mcp" });
      const b = await getOrCreateLink(h.svc, owner, { kind: "clip", clipId }, { source: "ui" });
      assert.equal(a.id, b.id);
    } finally {
      settings.MEDIA_LINK_TTL_DAYS = 90;
    }
  });

  it("lists newest first and pages in that order", async () => {
    const made = [];
    for (const label of ["first", "second", "third"]) {
      made.push((await getOrCreateLink(h.svc, owner, { kind: "clip", clipId }, { source: "ui", label })).id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const all = await listLinks(h.svc, owner, { clipId });
    assert.deepEqual(
      all.items.filter((l) => l.label).map((l) => l.id),
      [...made].reverse(),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listLinks(h.svc, owner, { clipId, limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((l) => l.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(
      seen,
      all.items.map((l) => l.id),
    );
  });
});
