/**
 * Sign-up rules against the running app: with sign-ups open, a hold rule sends a matching sign-up to approval
 * (and the account is told only that it waits), other sign-ups get straight in, a block rule refuses without
 * naming itself, the rule counts what it caught, and an admin can send an existing account back to approval.
 * Settings and rules are changed through the admin API and put back afterwards.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PENDING_APPROVAL_MESSAGE } from "@reelsaw/shared";
import { BASE, db, postSignUp, signUp } from "./helpers.js";

const json = { "content-type": "application/json", origin: BASE };
async function trpc(cookie: string, path: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url =
    method === "GET"
      ? `${BASE}/api/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`
      : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, { method, headers: { ...json, cookie }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string } } };
  return { status: res.status, data: body.result?.data as never, error: body.error };
}
/** A sign-up from a given (proxied) address: status, the server's text, the account and its session cookie. */
const trySignup = (email: string, ip: string) => postSignUp({ email, password: `pw-${randomUUID()}`, name: "Rule" }, { "x-forwarded-for": ip });

type Rule = { id: string; kind: string; pattern: string; action: string; hits: number };

describe("sign-up rules", () => {
  const pool = db();
  let admin: Awaited<ReturnType<typeof signUp>>;
  const made: string[] = [];
  const rules: string[] = [];
  const net = `198.51.${Math.floor(Math.random() * 200) + 20}`;
  const tag = randomUUID().slice(0, 8);
  const blockedDomain = `blocked-${tag}.example`;

  before(async () => {
    admin = await signUp();
    await pool.query(`update "user" set role = 'admin', approved_at = coalesce(approved_at, now()) where id = $1`, [admin.userId]);
    const s = await trpc(admin.cookie, "admin.settings.set", { SIGNUP_MODE: "open", REQUIRE_EMAIL_VERIFICATION: false, MAX_SIGNUPS_PER_IP_PER_DAY: 0 });
    // "Nothing to change": the instance already has these values
    if (s.error && s.error.message !== "Nothing to change") assert.fail(s.error.message);
    const r = await trpc(admin.cookie, "admin.signupRules.change", {
      add: [
        { kind: "ip", pattern: `${net}.0/24`, action: "hold", note: "stack test" },
        { kind: "domain", pattern: blockedDomain, action: "block" },
      ],
    });
    assert.equal(r.error, undefined, r.error?.message);
    rules.push(...(r.data as { added: Rule[] }).added.map((x) => x.id));
  });
  after(async () => {
    if (rules.length) await trpc(admin.cookie, "admin.signupRules.change", { remove: rules }).catch(() => {});
    await trpc(admin.cookie, "admin.settings.set", { SIGNUP_MODE: null, REQUIRE_EMAIL_VERIFICATION: null, MAX_SIGNUPS_PER_IP_PER_DAY: null }).catch(() => {});
    await pool.query(`delete from "user" where id = any($1)`, [[admin.userId, ...made]]);
    await pool.end();
  });

  it("holds a matching sign-up for approval without telling it why, and lets the rest in", async () => {
    const held = await trySignup(`held.${tag}@example.test`, `${net}.7`);
    assert.equal(held.status, 200, held.text);
    made.push(held.userId!);
    const row = await pool.query(`select approved_at, held_by from "user" where id = $1`, [held.userId]);
    assert.equal(row.rows[0].approved_at, null);
    assert.equal(row.rows[0].held_by, `ip ${net}.0/24`);
    const me = await trpc(held.cookie, "me.get", undefined, "GET");
    assert.equal(me.error, undefined, me.error?.message);
    const blocked = (me.data as { blocked: { kind: string; reason: string } | null }).blocked;
    assert.deepEqual(blocked, { kind: "pending", reason: PENDING_APPROVAL_MESSAGE });

    const free = await trySignup(`free.${tag}@example.test`, "203.0.113.77");
    assert.equal(free.status, 200, free.text);
    made.push(free.userId!);
    const freeRow = await pool.query(`select approved_at, held_by from "user" where id = $1`, [free.userId]);
    assert.notEqual(freeRow.rows[0].approved_at, null);
    assert.equal(freeRow.rows[0].held_by, null);

    const byRule = await trpc(admin.cookie, "admin.users.list", { heldBy: `ip ${net}.0/24` }, "GET");
    assert.equal(byRule.error, undefined, byRule.error?.message);
    assert.deepEqual(
      (byRule.data as { items: Array<{ id: string }> }).items.map((x) => x.id),
      [held.userId],
      "the rule's list holds the account it held, and nobody else",
    );

    const ev = await pool.query(`select payload from events where type = 'user.signed_up' and user_id = $1`, [held.userId]);
    assert.equal(ev.rows[0].payload.rule, `ip ${net}.0/24`);
    assert.equal(ev.rows[0].payload.ruleAction, "hold");
    assert.equal(ev.rows[0].payload.approved, false);
  });

  it("refuses a blocked sign-up with a sentence that names no rule", async () => {
    const r = await trySignup(`someone@mail.${blockedDomain}`, "203.0.113.78");
    assert.equal(r.status, 422, r.text);
    assert.match(r.text, /This sign-up cannot be accepted/);
    assert.ok(!r.text.includes(blockedDomain), r.text);
  });

  it("counts what each rule caught and says what the rules would do to a sign-up", async () => {
    const list = await trpc(admin.cookie, "admin.signupRules.list", { test: { email: "x@example.test", ip: `${net}.200` } }, "GET");
    assert.equal(list.error, undefined, list.error?.message);
    const data = list.data as { rules: Rule[]; test: { action: string; rule: string } };
    const hold = data.rules.find((x) => x.pattern === `${net}.0/24`)!;
    const block = data.rules.find((x) => x.pattern === blockedDomain)!;
    assert.ok(hold.hits >= 1 && block.hits >= 1, JSON.stringify(data.rules));
    assert.equal(data.test.action, "hold");
    assert.equal(data.test.rule, `ip ${net}.0/24`);
  });

  it("refuses a duplicate or unreadable rule with a sentence", async () => {
    const dup = await trpc(admin.cookie, "admin.signupRules.change", { add: [{ kind: "ip", pattern: `${net}.0/24`, action: "block" }] });
    assert.equal(dup.error?.data.code, "CONFLICT");
    assert.match(dup.error!.message, /already a rule/);
    const bad = await trpc(admin.cookie, "admin.signupRules.change", { add: [{ kind: "ip", pattern: "not-an-ip", action: "hold" }] });
    assert.equal(bad.error?.data.code, "BAD_REQUEST");
  });

  it("sends an existing account back to approval, and approving undoes it", async () => {
    const id = made[1]!;
    const held = await trpc(admin.cookie, "admin.users.bulk", { action: "hold", ids: [id, admin.userId] });
    assert.equal(held.error, undefined, held.error?.message);
    const r = held.data as { changed: number; skipped: Array<{ id: string; reason: string }> };
    assert.equal(r.changed, 1);
    assert.equal(r.skipped[0]?.id, admin.userId, "your own account is skipped with the reason");
    const row = await pool.query(`select approved_at from "user" where id = $1`, [id]);
    assert.equal(row.rows[0].approved_at, null);
    const ev = await pool.query(`select count(*)::int as n from events where type = 'user.held' and user_id = $1`, [id]);
    assert.equal(ev.rows[0].n, 1);
    const back = await trpc(admin.cookie, "admin.users.approve", { id });
    assert.equal(back.error, undefined, back.error?.message);
  });
});
