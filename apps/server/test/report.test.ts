/**
 * Issue reports against the running app: who may download them, that no configured secret leaves
 * the machine, that the manifest's hashes match, and that model settings are reported in full.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, db, dotenv, inContainer, readZip, sha256, signUp, toContainer } from "./helpers.js";

const SECRET_KEY = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|COOKIE/i;

describe("issue reports", () => {
  const pool = db();
  const env = dotenv();
  // shorter values are keyless-provider placeholders ("local", "ollama"), see MIN_SECRET_LENGTH
  const secrets = Object.entries(env).filter(([k, v]) => SECRET_KEY.test(k) && v.length >= 8).map(([, v]) => v);
  let owner: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  let admin: Awaited<ReturnType<typeof signUp>>;
  const projectId = randomUUID();
  const clipId = randomUUID();
  const otherProjectId = randomUUID();
  const stuckProjectId = randomUUID();

  before(async () => {
    owner = await signUp();
    other = await signUp();
    admin = await signUp();
    await pool.query(`update "user" set role = 'user' where id = any($1)`, [[owner.userId, other.userId]]);
    await pool.query(`update "user" set role = 'admin' where id = $1`, [admin.userId]);
    // a small project with secrets planted where logs/events/metadata could carry them
    const planted = { apiKey: secrets[0] ?? "none", header: "Authorization: Bearer abcdefghijklmnop123456", cookie: "cookie: session=s3cr3tsession", email: "someone@example.com" };
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, source_meta, duration_sec, status, settings)
       values ($1, $2, 'Report test', 'url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', $3, 60, 'done', '{}')`,
      [projectId, owner.userId, JSON.stringify({ uploader: "Someone", planted })],
    );
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, duration_sec, status, settings)
       values ($1, $2, 'OTHER_ACCOUNT_TITLE', 'url', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 90, 'failed', '{}')`,
      [otherProjectId, other.userId],
    );
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, duration_sec, status, stage, settings)
       values ($1, $2, 'STUCK_OTHER_TITLE', 'url', 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 30, 'rendering', 'render', '{}')`,
      [stuckProjectId, other.userId],
    );
    await pool.query(
      `insert into transcripts (project_id, language, text, words, raw_words, segments, flags) values ($1, 'en', 'hello world', $2, $2, $3, '[]')`,
      [projectId, JSON.stringify([{ text: "hello", start: 0, end: 0.5 }, { text: "world", start: 0.5, end: 1 }]), JSON.stringify([{ start: 0, end: 1, text: "hello world" }])],
    );
    await pool.query(`insert into clips (id, project_id, index, title, hook, start_sec, end_sec, score, reasoning, hashtags, status) values ($1, $2, 0, 'Clip', 'Hook', 0, 1, 80, 'why', '[]', 'done')`, [clipId, projectId]);
    await pool.query(`insert into project_events (project_id, type, payload) values ($1, 'stage.failed', $2)`, [projectId, JSON.stringify({ stage: "render", error: `upstream said ${planted.header}; key=${planted.apiKey}`, planted })]);
    await pool.query(`insert into stage_artifacts (project_id, stage, kind, models, data) values ($1, 'analyze', 'candidates', $2, $3)`, [projectId, JSON.stringify({ language: "test:model" }), JSON.stringify({ candidates: [] })]);
  });

  after(async () => {
    await pool.query(`delete from "user" where id = any($1)`, [[owner?.userId, other?.userId, admin?.userId].filter(Boolean)]);
    await pool.end();
  });

  const post = (path: string, cookie: string | null, body: unknown) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const req = { description: "The clip froze", clipIds: [clipId, randomUUID()], client: { route: `/p/${projectId}`, userAgent: "test", viewport: "1280x800" } };

  it("refuses anonymous requests (401)", async () => {
    assert.equal((await post(`/api/projects/${projectId}/report`, null, req)).status, 401);
  });

  it("hides other users' projects (404)", async () => {
    assert.equal((await post(`/api/projects/${projectId}/report`, other.cookie, req)).status, 404);
  });

  it("rejects an empty description (400)", async () => {
    assert.equal((await post(`/api/projects/${projectId}/report`, owner.cookie, { ...req, description: "" })).status, 400);
  });

  it("produces a complete zip with no secrets and matching hashes", async () => {
    const res = await post(`/api/projects/${projectId}/report`, owner.cookie, req);
    assert.equal(res.status, 200);
    const files = await readZip(Buffer.from(await res.arrayBuffer()));
    for (const name of ["README.md", "report.md", "manifest.json", "config.json", "project.json", "transcript.json", "clips.json", "artifacts.json", "events.jsonl", "client.json", "system.json", "queue.json", "usage.json"])
      assert.ok(files.has(name), `missing ${name}`);

    const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { files: Array<{ path: string; sha256: string; bytes: number }>; clipIds: string[] };
    assert.deepEqual(manifest.clipIds, [clipId], "only this project's clips are kept");
    for (const f of manifest.files) {
      assert.ok(files.has(f.path), `manifest lists missing ${f.path}`);
      assert.equal(sha256(files.get(f.path)!), f.sha256, `hash mismatch for ${f.path}`);
    }

    const text = [...files].filter(([n]) => !n.startsWith("media/")).map(([, b]) => b.toString()).join("\n");
    assert.ok(secrets.length > 0, "no secrets found in .env to check against");
    for (const s of secrets) assert.ok(!text.includes(s), `a configured secret (${s.slice(0, 3)}…) is in the report`);
    assert.ok(!text.includes("abcdefghijklmnop123456"), "bearer token leaked");
    assert.ok(!text.includes("s3cr3tsession"), "cookie leaked");
    assert.ok(!text.includes("someone@example.com"), "email leaked");
    assert.ok(!text.includes(owner.email), "owner email leaked");
    assert.ok(!text.includes(owner.userId), "owner id leaked (should be hashed)");

    const config = JSON.parse(files.get("config.json")!.toString()) as Record<string, unknown>;
    if (env.AI_MODEL) assert.equal(config.AI_MODEL, env.AI_MODEL, "model id must be reported in full");
    assert.ok(["set", "unset"].includes(String(config.BETTER_AUTH_SECRET)));
    assert.match(files.get("report.md")!.toString(), /untrusted/);
  });

  it("keeps other users' (and deleted projects') errors out of errors.jsonl", async () => {
    const gone = randomUUID(); // a project id that no longer exists
    const t = new Date().toISOString();
    const lines = [
      { level: 50, time: t, msg: "render failed", projectId: gone, title: "OTHER_USER_TITLE" },
      { level: 50, time: t, msg: "job crashed", jobId: randomUUID(), detail: "OTHER_JOB_DETAIL" },
      { level: 50, time: t, msg: "boot step failed", module: "boot", extra: "UNSCOPED_EXTRA", err: { type: "Error", message: "provider unreachable", stack: "UNSCOPED_STACK" } },
      { level: 50, time: t, msg: "own project error", projectId },
    ].map((l) => JSON.stringify(l)).join("\n");
    const file = `/data/logs/reelsaw.zz-test-${gone}.log`;
    const local = path.join(os.tmpdir(), `reelsaw-errlog-${gone}.log`);
    fs.writeFileSync(local, lines + "\n");
    inContainer(`mv ${toContainer(local, path.basename(local))} ${file}`);
    fs.rmSync(local);
    try {
      const res = await post(`/api/projects/${projectId}/report`, owner.cookie, req);
      const errors = (await readZip(Buffer.from(await res.arrayBuffer()))).get("errors.jsonl")!.toString();
      for (const leak of ["OTHER_USER_TITLE", gone, "OTHER_JOB_DETAIL", "UNSCOPED_EXTRA", "UNSCOPED_STACK"]) assert.ok(!errors.includes(leak), `errors.jsonl leaked ${leak}`);
      assert.match(errors, /provider unreachable/, "unscoped errors keep their message");
      assert.match(errors, /own project error/);
    } finally {
      inContainer(`rm -f ${file}`);
    }
  });

  it("makes an account-level report without a project", async () => {
    const res = await post(`/api/report`, owner.cookie, { description: "Something odd", client: {} });
    assert.equal(res.status, 200);
    const files = await readZip(Buffer.from(await res.arrayBuffer()));
    assert.ok(files.has("projects.json"));
    const projects = JSON.parse(files.get("projects.json")!.toString()) as Array<{ id: string }>;
    assert.deepEqual(projects.map((p) => p.id), [projectId]);
  });

  it("omits system.json / queue / errors when include.system is false", async () => {
    const res = await post(`/api/projects/${projectId}/report`, owner.cookie, {
      ...req,
      include: { logs: false, system: false, instance: false, previews: false, allClips: false, source: false },
    });
    assert.equal(res.status, 200);
    const files = await readZip(Buffer.from(await res.arrayBuffer()));
    for (const name of ["system.json", "queue.json", "usage.json", "errors.jsonl", "stuck.json"]) assert.ok(!files.has(name), `${name} must not be present`);
    const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { include: { system: boolean; instance: boolean } };
    assert.equal(manifest.include.system, false);
    assert.equal(manifest.include.instance, false);
  });

  it("ignores include.instance from a non-admin", async () => {
    const res = await post(`/api/report`, owner.cookie, {
      description: "The queue looks stuck",
      include: { logs: true, system: true, instance: true, previews: false, allClips: false, source: false },
    });
    assert.equal(res.status, 200);
    const files = await readZip(Buffer.from(await res.arrayBuffer()));
    assert.ok(!files.has("stuck.json"), "non-admins must not get instance stuck.json");
    const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { include: { instance: boolean } };
    assert.equal(manifest.include.instance, false);
    const projects = JSON.parse(files.get("projects.json")!.toString()) as Array<{ id: string; title?: string }>;
    assert.ok(Array.isArray(projects), "own-account projects.json is a list of the reporter's projects");
    assert.ok(!projects.some((p) => p.id === otherProjectId || p.title === "OTHER_ACCOUNT_TITLE"));
    const text = [...files].map(([, b]) => b.toString()).join("\n");
    assert.ok(!text.includes("OTHER_ACCOUNT_TITLE"));
    assert.ok(!text.includes("STUCK_OTHER_TITLE"));
    assert.ok(!text.includes(other.email));
  });

  it("admin instance report includes other accounts' unfinished work, not their emails", async () => {
    const t = new Date().toISOString();
    const gone = randomUUID();
    const lines = [
      { level: 50, time: t, msg: "other account crashed", projectId: otherProjectId, title: "OTHER_ACCOUNT_TITLE" },
      { level: 50, time: t, msg: "job crashed", jobId: gone, detail: "INSTANCE_JOB_DETAIL" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const file = `/data/logs/reelsaw.zz-instance-${gone}.log`;
    const local = path.join(os.tmpdir(), `reelsaw-instance-${gone}.log`);
    fs.writeFileSync(local, lines + "\n");
    inContainer(`mv ${toContainer(local, path.basename(local))} ${file}`);
    fs.rmSync(local);
    try {
      const res = await post(`/api/report`, admin.cookie, {
        description: "The queue is backed up",
        include: { logs: true, system: true, instance: true, previews: false, allClips: false, source: false },
      });
      assert.equal(res.status, 200);
      const files = await readZip(Buffer.from(await res.arrayBuffer()));
      for (const name of ["stuck.json", "projects.json", "system.json", "queue.json", "usage.json", "errors.jsonl"]) {
        assert.ok(files.has(name), `missing ${name}`);
      }
      const stuck = JSON.parse(files.get("stuck.json")!.toString()) as { projects: Array<{ id: string; title: string; ownerHash: string }> };
      assert.ok(stuck.projects.some((p) => p.id === stuckProjectId && p.title === "STUCK_OTHER_TITLE"));
      const summaries = JSON.parse(files.get("projects.json")!.toString()) as { projects: Array<{ id: string; title: string; ownerHash: string }> };
      assert.ok(summaries.projects.some((p) => p.id === otherProjectId && p.title === "OTHER_ACCOUNT_TITLE"));
      assert.ok(summaries.projects.some((p) => p.id === stuckProjectId));
      const system = JSON.parse(files.get("system.json")!.toString()) as { accounts?: unknown; workers?: unknown; disk?: unknown };
      assert.ok(system.accounts, "instance system.json includes account counts");
      assert.ok(system.workers, "instance system.json includes workers");
      const usage = JSON.parse(files.get("usage.json")!.toString()) as { scope: string };
      assert.equal(usage.scope, "instance");
      const queue = JSON.parse(files.get("queue.json")!.toString()) as { scope: string };
      assert.equal(queue.scope, "instance");
      const errors = files.get("errors.jsonl")!.toString();
      assert.match(errors, /OTHER_ACCOUNT_TITLE/);
      assert.match(errors, /INSTANCE_JOB_DETAIL/);
      const text = [...files].filter(([n]) => !n.startsWith("media/")).map(([, b]) => b.toString()).join("\n");
      assert.ok(!text.includes(other.email), "other account email leaked");
      assert.ok(!text.includes(other.userId), "other account id leaked (should be hashed)");
      assert.ok(!text.includes(admin.email), "admin email leaked");
      const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { include: { instance: boolean; system: boolean } };
      assert.equal(manifest.include.instance, true);
      assert.equal(manifest.include.system, true);
    } finally {
      inContainer(`rm -f ${file}`);
    }
  });
});
