/**
 * Abuse guards against the running app: a temporary-address domain is refused once the setting is on, the
 * accounts-per-address cap holds, one mailbox cannot register twice, and the per-account change rate refuses
 * with a sentence. Settings are changed through the admin API and put back afterwards.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, db, signUp } from "./helpers.js";

const json = { "content-type": "application/json", origin: BASE };
async function trpc(cookie: string, path: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url = method === "GET" ? `${BASE}/api/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}` : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, { method, headers: { ...json, cookie }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string } } };
  return { status: res.status, data: body.result?.data as never, error: body.error };
}
/** A raw sign-up attempt from a given (proxied) address; returns the status and the server's sentence. */
async function trySignup(email: string, ip: string) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { ...json, "x-forwarded-for": ip }, body: JSON.stringify({ email, password: `pw-${randomUUID()}`, name: "Guard" }) });
    const text = await res.text();
    if (res.status !== 429 || attempt >= 12) {
      let userId: string | null = null;
      try {
        userId = (JSON.parse(text) as { user?: { id: string } }).user?.id ?? null;
      } catch {}
      return { status: res.status, text, userId };
    }
    await new Promise((r) => setTimeout(r, 2500 + Math.random() * 1500));
  }
}

describe("abuse guards", () => {
  const pool = db();
  let admin: Awaited<ReturnType<typeof signUp>>;
  const made: string[] = [];
  before(async () => {
    admin = await signUp();
    await pool.query(`update "user" set role = 'admin' where id = $1`, [admin.userId]);
    const r = await trpc(admin.cookie, "admin.settings.set", { BLOCK_DISPOSABLE_EMAILS: true, MAX_SIGNUPS_PER_IP_PER_DAY: 2 });
    assert.equal(r.error, undefined, r.error?.message);
  });
  after(async () => {
    await trpc(admin.cookie, "admin.settings.set", { BLOCK_DISPOSABLE_EMAILS: null, MAX_SIGNUPS_PER_IP_PER_DAY: null }).catch(() => {});
    await pool.query(`delete from "user" where id = any($1)`, [[admin.userId, ...made]]);
    await pool.end();
  });

  it("refuses a temporary-address domain with a sentence", async () => {
    const r = await trySignup(`t-${randomUUID().slice(0, 8)}@mailinator.com`, "203.0.113.9");
    assert.equal(r.status, 422, r.text);
    assert.match(r.text, /Temporary email addresses cannot be used here/);
  });

  it("caps accounts per address per day and keeps one account per mailbox", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;
    const tag = randomUUID().slice(0, 8);
    const a = await trySignup(`guard.${tag}@example.test`, ip);
    assert.equal(a.status, 200, a.text);
    made.push(a.userId!);
    const b = await trySignup(`other.${tag}@example.test`, ip);
    assert.equal(b.status, 200, b.text);
    made.push(b.userId!);
    const c = await trySignup(`third.${tag}@example.test`, ip);
    assert.equal(c.status, 422, c.text);
    assert.match(c.text, /Too many accounts were created from this network today/);
    const dup = await trySignup(`Guard.${tag}+promo@example.test`, "203.0.113.250");
    assert.equal(dup.status, 422, dup.text);
    assert.match(dup.text, /An account already exists for this email address/);
    const stored = await pool.query(`select email_key, signup_ip from "user" where id = $1`, [a.userId]);
    assert.equal(stored.rows[0].email_key, `guard.${tag}@example.test`);
    assert.equal(stored.rows[0].signup_ip, ip);
  });

  it("refuses the fourth change in a minute with a sentence (per-user override); reads are not counted", async () => {
    const u = await signUp();
    made.push(u.userId);
    const set = await trpc(admin.cookie, "admin.users.setLimits", { id: u.userId, limits: { MAX_REQUESTS_PER_MINUTE: 3 } });
    assert.equal(set.error, undefined, set.error?.message);
    for (let i = 0; i < 3; i++) {
      const r = await trpc(u.cookie, "me.updateProjectDefaults", { language: "en" });
      assert.equal(r.error, undefined, r.error?.message);
    }
    const fourth = await trpc(u.cookie, "me.updateProjectDefaults", { language: "en" });
    assert.equal(fourth.error?.data.code, "TOO_MANY_REQUESTS");
    assert.match(fourth.error!.message, /More than 3 changes in a minute/);
    const read = await trpc(u.cookie, "me.get", undefined, "GET");
    assert.equal(read.error, undefined);
    const lim = (await trpc(admin.cookie, "admin.users.limits", { id: u.userId }, "GET")).data as { usage: Record<string, number>; source: Record<string, string> };
    assert.equal(lim.source.MAX_REQUESTS_PER_MINUTE, "override");
    assert.ok(lim.usage.MAX_REQUESTS_PER_MINUTE >= 3);
  });

  it("the flag pass marks the shared address and the Users page can filter on it", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
    await trpc(admin.cookie, "admin.settings.set", { MAX_SIGNUPS_PER_IP_PER_DAY: 0 });
    for (let i = 0; i < 3; i++) {
      const r = await trySignup(`farm.${randomUUID().slice(0, 8)}@example.test`, ip);
      assert.equal(r.status, 200, r.text);
      made.push(r.userId!);
    }
    const { flagAccounts } = await import("../src/abuse.js");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { schema } = await import("../src/db/index.js");
    const d = drizzle(pool, { schema });
    const fake = { database: { db: d } as never, log: { child: () => ({ info() {}, warn() {} }) } as never, tx: async (fn: (u: { db: typeof d }) => Promise<void>) => fn({ db: d }) };
    const r = await flagAccounts(fake as never);
    assert.ok(r.flagged >= 3, `flagged ${r.flagged}`);
    const list = (await trpc(admin.cookie, "admin.users.list", { flagged: true, limit: 100 }, "GET")).data as { items: Array<{ signupIp: string | null; flags: string[] }> };
    const ours = list.items.filter((x) => x.signupIp === ip);
    assert.equal(ours.length, 3);
    for (const x of ours) assert.ok(x.flags.includes("shared_ip"), x.flags.join(","));
    const ev = await pool.query(`select count(*)::int as n from admin_events where type = 'user.flagged' and user_id = any($1)`, [made.slice(-3)]);
    assert.equal(ev.rows[0].n, 3);
  });
});
