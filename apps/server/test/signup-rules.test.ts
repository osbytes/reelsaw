/** Sign-up rules without a database: how patterns are read and which rule decides a sign-up. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideSignup, normalizePattern, ruleLabel, type SignupRule } from "../src/signup-rules.js";

let n = 0;
const rule = (kind: SignupRule["kind"], pattern: string, action: SignupRule["action"] = "hold"): SignupRule => ({ id: `r${++n}`, kind, pattern, action });
const facts = (email: string, ip: string | null = null, flags: Array<"shared_ip" | "signup_burst" | "disposable_email"> = []) => ({ email, ip, flags });

describe("normalizePattern", () => {
  it("takes addresses and CIDR ranges of either family, and refuses the rest with a sentence", () => {
    assert.deepEqual(normalizePattern("ip", " 203.0.113.7 "), { pattern: "203.0.113.7" });
    assert.deepEqual(normalizePattern("ip", "203.0.113.0/24"), { pattern: "203.0.113.0/24" });
    assert.deepEqual(normalizePattern("ip", "2001:DB8::/32"), { pattern: "2001:db8::/32" });
    assert.deepEqual(normalizePattern("ip", "::ffff:198.51.100.4"), { pattern: "198.51.100.4" });
    assert.ok("error" in normalizePattern("ip", "203.0.113.0/33"));
    assert.ok("error" in normalizePattern("ip", "example.com"));
    assert.ok("error" in normalizePattern("ip", "1.2.3.4/8/9"));
  });
  it("lower-cases emails and domains, and refuses a pattern that would match everyone", () => {
    assert.deepEqual(normalizePattern("email", "Spam*@Gmail.com"), { pattern: "spam*@gmail.com" });
    assert.ok("error" in normalizePattern("email", "*@*"));
    assert.ok("error" in normalizePattern("email", "no-at-sign"));
    assert.deepEqual(normalizePattern("domain", "@Example.COM"), { pattern: "example.com" });
    assert.deepEqual(normalizePattern("domain", "*.example.com"), { pattern: "example.com" });
    assert.ok("error" in normalizePattern("domain", "localhost"));
  });
  it("knows the abuse flags", () => {
    assert.deepEqual(normalizePattern("flag", "shared_ip"), { pattern: "shared_ip" });
    assert.ok("error" in normalizePattern("flag", "suspicious"));
  });
});

describe("decideSignup", () => {
  it("matches an address and a range, IPv4-mapped IPv6 included, and never an unknown address", () => {
    const rules = [rule("ip", "203.0.113.0/24"), rule("ip", "2001:db8::/32")];
    assert.equal(decideSignup(rules, facts("a@x.com", "203.0.113.200")).action, "hold");
    assert.equal(decideSignup(rules, facts("a@x.com", "::ffff:203.0.113.5")).action, "hold");
    assert.equal(decideSignup(rules, facts("a@x.com", "2001:db8:1::9")).action, "hold");
    assert.equal(decideSignup(rules, facts("a@x.com", "198.51.100.1")).action, null);
    assert.equal(decideSignup(rules, facts("a@x.com", null)).action, null);
  });
  it("matches an email glob on the address and on the mailbox it really is", () => {
    const rules = [rule("email", "riyad*@gmail.com")];
    assert.equal(decideSignup(rules, facts("Riyad.Benelbou4@gmail.com")).action, "hold");
    assert.equal(
      decideSignup([rule("email", "riyadbenelbou*@gmail.com")], facts("riyad.benelbou2+x@gmail.com")).action,
      "hold",
      "…but the folded mailbox matches",
    );
    assert.equal(decideSignup(rules, facts("riyad.b@gmail.com")).action, "hold");
    assert.equal(decideSignup(rules, facts("someone@gmail.com")).action, null);
    assert.equal(decideSignup([rule("email", "a.b@x.com")], facts("aXb@x.com")).action, null, "a dot in the pattern is a dot");
  });
  it("matches a domain and its subdomains, not a lookalike", () => {
    const rules = [rule("domain", "example.com")];
    assert.equal(decideSignup(rules, facts("a@example.com")).action, "hold");
    assert.equal(decideSignup(rules, facts("a@mail.example.com")).action, "hold");
    assert.equal(decideSignup(rules, facts("a@badexample.com")).action, null);
  });
  it("matches the flags worked out at sign-up", () => {
    const rules = [rule("flag", "shared_ip")];
    assert.equal(decideSignup(rules, facts("a@x.com", "1.2.3.4", ["shared_ip"])).action, "hold");
    assert.equal(decideSignup(rules, facts("a@x.com", "1.2.3.4", ["disposable_email"])).action, null);
  });
  it("block beats allow beats hold, and the oldest of the winning action decides", () => {
    const hold = rule("domain", "gmail.com", "hold");
    const allow = rule("email", "friend@gmail.com", "allow");
    const block = rule("ip", "203.0.113.0/24", "block");
    const allow2 = rule("ip", "198.51.100.0/24", "allow");
    assert.equal(decideSignup([hold, allow], facts("friend@gmail.com")).rule, allow);
    assert.equal(decideSignup([hold, allow, block], facts("friend@gmail.com", "203.0.113.1")).rule, block);
    const both = decideSignup([hold, allow, allow2], facts("friend@gmail.com", "198.51.100.3"));
    assert.equal(both.rule, allow);
    assert.deepEqual(
      both.matched.map((r) => r.id),
      [allow.id, allow2.id, hold.id],
    );
    assert.equal(ruleLabel(block), "ip 203.0.113.0/24");
  });
});
