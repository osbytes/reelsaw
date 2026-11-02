/**
 * The one events table across a project's and an account's life: a project's events outlive "Delete forever"
 * (what Reelsaw learned from it, like its decisions), go when the owner forgets, and go with the account; the
 * account's own events stay as the record. Postgres only.  node --import tsx --test test/events-lifecycle.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { purgeProject } from "../src/projects/service.js";
import { forgetDecisions } from "../src/decisions/service.js";
import { removeUser } from "../src/accounts.js";
import type { Services } from "../src/services.js";

const h = lifecycleHarness();
const notReady = await h.ready();
after(() => h.cleanup());
const svc = { ...h.svc, telemetry: { capture() {} }, storage: { delete: async () => {}, deletePrefix: async () => {} } } as unknown as Services;

const count = async (where: string, args: unknown[]) => (await h.pool.query(`select count(*)::int as n from events where ${where}`, args)).rows[0].n;

describe("events across a project's and an account's life", { skip: notReady ?? false }, () => {
  it("records a project event's account as the project's owner, and who acted", async () => {
    const u = await h.makeUser();
    const p = await h.makeProject(u, "done");
    await svc.tx((w) => w.emit("project.updated", { projectId: p, changed: ["title"] }, { actorId: "admin-1" }));
    const r = await h.pool.query(`select user_id, actor_id from events where project_id = $1`, [p]);
    assert.deepEqual(r.rows, [{ user_id: u, actor_id: "admin-1" }]);
  });

  it("keeps a deleted-forever project's events until the owner forgets them", async () => {
    const u = await h.makeUser();
    const p = await h.makeProject(u, "done");
    await svc.tx((w) => w.emit("project.updated", { projectId: p, changed: ["title"] }));
    await svc.tx((w) => purgeProject(svc, w, p));
    assert.equal(await count("project_id = $1", [p]), 1);
    await svc.tx((w) => forgetDecisions(w.db, u, { projectId: p }));
    assert.equal(await count("project_id = $1", [p]), 0);
  });

  it("forgetting everything leaves a live project's history alone", async () => {
    const u = await h.makeUser();
    const live = await h.makeProject(u, "done");
    const gone = await h.makeProject(u, "done");
    await svc.tx(async (w) => {
      await w.emit("project.updated", { projectId: live, changed: ["title"] });
      await w.emit("project.updated", { projectId: gone, changed: ["title"] });
    });
    await svc.tx((w) => purgeProject(svc, w, gone));
    await svc.tx((w) => forgetDecisions(w.db, u));
    assert.equal(await count("project_id = $1", [live]), 1);
    assert.equal(await count("project_id = $1", [gone]), 0);
  });

  it("removing the account takes its projects' events and keeps its account events", async () => {
    const u = await h.makeUser();
    const p = await h.makeProject(u, "done");
    await svc.tx(async (w) => {
      await w.emit("project.updated", { projectId: p, changed: ["title"] });
      await w.emit("user.banned", { userId: u, email: `${u}@example.test`, reason: "test" });
    });
    await removeUser(svc, null, u);
    assert.equal(await count("user_id = $1 and project_id is not null", [u]), 0);
    assert.deepEqual(
      (await h.pool.query(`select type from events where user_id = $1 order by id`, [u])).rows.map((r) => r.type),
      ["user.banned", "user.removed"],
    );
  });
});
