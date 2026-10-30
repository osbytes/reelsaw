import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyProxySession,
  classifyYtdlpError,
  createYtdlpProxyPool,
  parseYtdlpProxies,
  PROXY_SESSION_TOKEN,
  proxyHost,
  type ProxyCandidate,
} from "../src/ytdlp-proxy.js";

const cheap: ProxyCandidate = { id: "pi", url: "socks5h://100.64.1.10:1080", priority: 20, concurrency: 0 };
const paid: ProxyCandidate = { id: "paid", url: "http://user:pass@gate.example:7000", priority: 1, concurrency: 0 };
const bot = () => Promise.reject(new Error("ERROR: [youtube] Sign in to confirm you're not a bot. HTTP Error 403"));
const privateVideo = () => Promise.reject(new Error("ERROR: This video is private"));

describe("parseYtdlpProxies", () => {
  it("parses a single URL the way YTDLP_PROXY always did", () => {
    assert.deepEqual(parseYtdlpProxies("http://user:pass@host.example:8080"), [
      { id: "host.example-8080", url: "http://user:pass@host.example:8080", priority: 100, concurrency: 0 },
    ]);
  });
  it("takes id, priority and concurrency from the spec; direct means no --proxy", () => {
    const got = parseYtdlpProxies(
      "pi=socks5h://100.64.1.10:1080;priority=20;concurrency=1, racknerd=http://100.64.1.20:8888;priority=10, home=direct;priority=5",
    );
    assert.deepEqual(got, [
      { id: "pi", url: "socks5h://100.64.1.10:1080", priority: 20, concurrency: 1 },
      { id: "racknerd", url: "http://100.64.1.20:8888", priority: 10, concurrency: 0 },
      { id: "home", url: null, priority: 5, concurrency: 0 },
    ]);
  });
  it("a comma-separated list is the pool, a bare URL is still one candidate", () => {
    const pooled = parseYtdlpProxies("pi=socks5h://100.64.1.10:1080;priority=20,paid=http://paid.example:1;priority=1");
    assert.equal(pooled.length, 2);
    assert.equal(pooled[0]!.priority, 20);
    assert.equal(parseYtdlpProxies("socks5h://100.64.1.10:1080").length, 1);
  });
  it("rejects a bad entry without echoing a password", () => {
    assert.throws(() => parseYtdlpProxies("pi=not-a-url;priority=1"), /not a proxy URL/);
    try {
      parseYtdlpProxies("http://user:s3cret@host:1;concurrency=-1");
      assert.fail("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /bad concurrency/);
      assert.doesNotMatch(msg, /s3cret/);
    }
  });
  it("proxyHost never includes userinfo", () => {
    assert.equal(proxyHost("http://user:s3cret@gate.example:7000"), "gate.example:7000");
    assert.equal(proxyHost(null), "direct");
  });
  it("keeps a residential username with {session} and provider semicolons", () => {
    const got = parseYtdlpProxies("di=http://login__cr.us;sessid.{session};sessttl.60:pass@gw.example:823;priority=1;concurrency=4");
    assert.deepEqual(got, [{ id: "di", url: "http://login__cr.us;sessid.{session};sessttl.60:pass@gw.example:823", priority: 1, concurrency: 4 }]);
  });
});

describe("applyProxySession", () => {
  it("leaves a URL without {session} alone", () => {
    assert.equal(applyProxySession("http://user:pass@gate.example:7000"), "http://user:pass@gate.example:7000");
  });
  it("fills {session} with the given id and does not leave the token", () => {
    const url = applyProxySession("http://login__cr.us;sessid.{session};sessttl.60:pass@gw.example:823", "a1b2c3d4e5f6a7b8");
    assert.equal(url, "http://login__cr.us;sessid.a1b2c3d4e5f6a7b8;sessttl.60:pass@gw.example:823");
    assert.ok(!url.includes(PROXY_SESSION_TOKEN));
  });
});

describe("classifyYtdlpError", () => {
  it("splits path failures from the video itself", () => {
    assert.equal(classifyYtdlpError("Sign in to confirm you're not a bot"), "proxy");
    assert.equal(classifyYtdlpError("Unable to connect to proxy"), "proxy");
    assert.equal(classifyYtdlpError("This video is private"), "content");
    assert.equal(classifyYtdlpError("The operation was aborted"), "abort");
    assert.equal(classifyYtdlpError("yt-dlp exited with 1"), "other");
  });
});

describe("proxy pool ranking", () => {
  it("picks the operator's highest priority while both are healthy, even after the cheaper one has failed once", async () => {
    const pool = createYtdlpProxyPool([cheap, paid], { faultsBeforeOpen: 2, halfOpenAfter: 60_000 });
    assert.equal(pool.snapshot().next, "pi");
    await assert.rejects(() => pool.run(bot), /not a bot/);
    // one fault is not enough to open the circuit; priority still wins
    assert.equal(pool.snapshot().next, "pi");
    assert.equal(pool.snapshot().candidates.find((c) => c.id === "pi")?.circuit, "closed");
  });

  it("does not let a more reliable lower-priority proxy overtake a healthy higher-priority one", async () => {
    const pool = createYtdlpProxyPool([cheap, paid], { faultsBeforeOpen: 1, halfOpenAfter: 40 });
    const failPi = async ({ id }: { id: string }) => {
      if (id === "pi") throw new Error("ERROR: [youtube] Sign in to confirm you're not a bot. HTTP Error 403");
      return id;
    };
    await pool.run(failPi);
    assert.equal(pool.snapshot().candidates.find((c) => c.id === "pi")?.healthy, false);
    assert.equal(pool.snapshot().next, "paid");
    // paid succeeds several times (what a blended score would promote)
    for (let i = 0; i < 4; i++) await pool.run(async ({ id }) => id);
    assert.equal(pool.snapshot().candidates.find((c) => c.id === "paid")?.successes, 5);
    // after cooldown the operator ranking returns: Pi, not paid (paid has more successes)
    await new Promise((r) => setTimeout(r, 50));
    const { id } = await pool.run(async ({ id: used }) => used);
    assert.equal(id, "pi");
    assert.equal(pool.snapshot().next, "pi");
  });

  it("walks to the next priority on a proxy fault, but not on a private video", async () => {
    const pool = createYtdlpProxyPool([cheap, paid], { faultsBeforeOpen: 2, halfOpenAfter: 60_000 });
    const tries: string[] = [];
    const { id } = await pool.run(async ({ id: used }) => {
      tries.push(used);
      if (used === "pi") throw new Error("Unable to connect to proxy");
      return "ok";
    });
    assert.equal(id, "paid");
    assert.deepEqual(tries, ["pi", "paid"]);

    const content = createYtdlpProxyPool([cheap, paid], { faultsBeforeOpen: 2, halfOpenAfter: 60_000 });
    const contentTries: string[] = [];
    await assert.rejects(
      () =>
        content.run(async ({ id: used }) => {
          contentTries.push(used);
          return privateVideo();
        }),
      /private/,
    );
    assert.deepEqual(contentTries, ["pi"]);
  });

  it("overflows a concurrency cap to the next priority instead of waiting on the cheap one", async () => {
    const pi = { ...cheap, concurrency: 1 };
    const pool = createYtdlpProxyPool([pi, paid], { halfOpenAfter: 60_000, slotWaitMs: 5 });
    let release!: (v: string) => void;
    const held = pool.run(
      ({ id }) =>
        new Promise<string>((r) => {
          release = r;
          void id;
        }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const { id } = await pool.run(async ({ id: used }) => used);
    assert.equal(id, "paid");
    release!("done");
    assert.equal((await held).id, "pi");
  });

  it("does not print credentials in snapshots", () => {
    const pool = createYtdlpProxyPool([paid]);
    const row = pool.snapshot().candidates[0]!;
    assert.equal(row.host, "gate.example:7000");
    assert.ok(!JSON.stringify(row).includes("pass"));
  });

  it("fills {session} with a distinct id on every download", async () => {
    const rotating: ProxyCandidate = { id: "di", url: "http://login__cr.us;sessid.{session};sessttl.60:pass@gw.example:823", priority: 1, concurrency: 0 };
    const pool = createYtdlpProxyPool([rotating], { faultsBeforeOpen: 5, halfOpenAfter: 60_000 });
    const urls: string[] = [];
    await pool.run(async ({ args }) => {
      urls.push(args[1]!);
      return "ok";
    });
    await pool.run(async ({ args }) => {
      urls.push(args[1]!);
      return "ok";
    });
    assert.equal(urls.length, 2);
    assert.match(urls[0]!, /sessid\.[0-9a-f]{16};/);
    assert.match(urls[1]!, /sessid\.[0-9a-f]{16};/);
    assert.notEqual(urls[0], urls[1]);
    assert.ok(urls.every((u) => !u.includes(PROXY_SESSION_TOKEN)));
  });

  it("does not rewrite a URL without {session}", async () => {
    const pool = createYtdlpProxyPool([paid]);
    const { value } = await pool.run(async ({ args }) => args[1] ?? "");
    assert.equal(value, paid.url);
  });

  it("mints a new session when the pool walks to the next candidate", async () => {
    const a: ProxyCandidate = { id: "a", url: "http://login;sessid.{session}:p@gw.example:823", priority: 2, concurrency: 0 };
    const b: ProxyCandidate = { id: "b", url: "http://login;sessid.{session}:p@gw.example:824", priority: 1, concurrency: 0 };
    const pool = createYtdlpProxyPool([a, b], { faultsBeforeOpen: 5, halfOpenAfter: 60_000 });
    const urls: string[] = [];
    await pool.run(async ({ args }) => {
      urls.push(args[1]!);
      if (urls.length === 1) throw new Error("Unable to connect to proxy");
      return "ok";
    });
    assert.equal(urls.length, 2);
    assert.notEqual(urls[0], urls[1]);
    assert.ok(urls.every((u) => !u.includes(PROXY_SESSION_TOKEN)));
  });
});
