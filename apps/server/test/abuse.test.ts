/** Sign-up guard helpers that need no database: the client address behind a proxy, the mailbox key, disposable domains. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientIp, WindowCounter, emailKey, isDisposable, emailDomain } from "../src/abuse.js";
import { CLIENT_IP_HEADER, withClientIp } from "../src/auth.js";

const trust = (over: Partial<Parameters<typeof clientIp>[1]> = {}): Parameters<typeof clientIp>[1] => ({
  TRUST_PROXY: true,
  TRUSTED_PROXY_HEADER: "x-forwarded-for",
  TRUSTED_PROXY_HOPS: 1,
  ...over,
});

describe("clientIp", () => {
  it("takes the X-Forwarded-For entry `hops` from the right, so entries a client prepends are ignored", () => {
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 6.6.6.6, 2.2.2.2" }), trust()), "2.2.2.2");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2" }), trust()), "2.2.2.2");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": " 9.9.9.9 , 2.2.2.2 , 3.3.3.3" }), trust({ TRUSTED_PROXY_HOPS: 2 })), "2.2.2.2");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2" }), trust({ TRUSTED_PROXY_HOPS: 2 })), null);
  });
  it("reads only the selected header", () => {
    const h = new Headers({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "4.4.4.4", "x-forwarded-for": "2.2.2.2" });
    assert.equal(clientIp(h, trust()), "2.2.2.2");
    assert.equal(clientIp(h, trust({ TRUSTED_PROXY_HEADER: "cf-connecting-ip" })), "1.1.1.1");
    assert.equal(clientIp(h, trust({ TRUSTED_PROXY_HEADER: "x-real-ip" })), "4.4.4.4");
    assert.equal(clientIp(new Headers({ "cf-connecting-ip": "1.1.1.1" }), trust()), null);
  });
  it("is null when the proxy is not trusted or the header is missing", () => {
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2" }), trust({ TRUST_PROXY: false })), null);
    assert.equal(clientIp(new Headers(), trust()), null);
  });
});

describe("withClientIp (the address Better Auth rate-limits on)", () => {
  const post = (headers: Record<string, string>) =>
    new Request("http://app.test/api/auth/sign-in/email", { method: "POST", headers, body: JSON.stringify({ email: "a@b.test" }) });
  it("hands Better Auth the resolved address from a multi-hop X-Forwarded-For, and keeps the body", async () => {
    const r = withClientIp(post({ "x-forwarded-for": "9.9.9.9, 2.2.2.2", "content-type": "application/json" }), trust());
    assert.equal(r.headers.get(CLIENT_IP_HEADER), "2.2.2.2");
    assert.deepEqual(await r.json(), { email: "a@b.test" });
  });
  it("drops a client-sent value, and sends none when the proxy is not trusted", () => {
    assert.equal(withClientIp(post({ [CLIENT_IP_HEADER]: "6.6.6.6", "x-forwarded-for": "2.2.2.2" }), trust()).headers.get(CLIENT_IP_HEADER), "2.2.2.2");
    assert.equal(
      withClientIp(post({ [CLIENT_IP_HEADER]: "6.6.6.6", "x-forwarded-for": "2.2.2.2" }), trust({ TRUST_PROXY: false })).headers.get(CLIENT_IP_HEADER),
      null,
    );
  });
});

describe("WindowCounter", () => {
  it("allows `max` hits per key per window, then refuses until the next window", () => {
    let t = 0;
    const c = new WindowCounter(2, 1000, () => t);
    assert.deepEqual([c.hit("a"), c.hit("a"), c.hit("a"), c.hit("b")], [true, true, false, true]);
    t = 1000;
    assert.equal(c.hit("a"), true);
  });
});

describe("emailKey", () => {
  it("folds case, gmail dots and +tags; keeps dots elsewhere", () => {
    assert.equal(emailKey("John.Doe+promo@Gmail.com"), "johndoe@gmail.com");
    assert.equal(emailKey("john.doe@googlemail.com"), "johndoe@gmail.com");
    assert.equal(emailKey("Jane.Roe+x@Example.org"), "jane.roe@example.org");
    assert.equal(emailKey("nobody"), "nobody");
  });
});

describe("isDisposable", () => {
  it("knows the common services and their subdomains, not ordinary providers", () => {
    assert.equal(isDisposable("a@mailinator.com"), true);
    assert.equal(isDisposable("a@mail.mailinator.com"), true);
    assert.equal(isDisposable("a@gmail.com"), false);
    assert.equal(isDisposable("a@example.test"), false);
    assert.equal(emailDomain("A@Example.COM"), "example.com");
  });
});
