/** Sign-up guard helpers that need no database: the client address behind a proxy, the mailbox key, disposable domains. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clientIp, emailKey, isDisposable, emailDomain } from "../src/abuse.js";

describe("clientIp", () => {
  it("prefers Cloudflare, then X-Real-IP, then the first X-Forwarded-For hop; nothing when the proxy is not trusted", () => {
    assert.equal(clientIp(new Headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2, 3.3.3.3" }), true), "1.1.1.1");
    assert.equal(clientIp(new Headers({ "x-real-ip": "4.4.4.4", "x-forwarded-for": "2.2.2.2" }), true), "4.4.4.4");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": " 2.2.2.2 , 3.3.3.3" }), true), "2.2.2.2");
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2" }), false), null);
    assert.equal(clientIp(new Headers(), true), null);
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
