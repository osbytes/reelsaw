/** The shared matchers: `globMatch` (lib/glob.ts) and address ranges (lib/ip.ts). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globMatch } from "../src/lib/glob.js";
import { formatRange, inRange, parseRange } from "../src/lib/ip.js";

describe("globMatch", () => {
  it("anchors at both ends and treats everything but * literally", () => {
    assert.ok(globMatch("spam*@gmail.com", "spam.bot+1@gmail.com"));
    assert.ok(!globMatch("spam*@gmail.com", "xspam@gmail.com"));
    assert.ok(!globMatch("spam*@gmail.com", "spam@gmail.com.evil"));
    assert.ok(globMatch("a.b@x.com", "a.b@x.com"));
    assert.ok(!globMatch("a.b@x.com", "aXb@x.com"));
    assert.ok(globMatch("*@x.com", "@x.com"));
    assert.ok(globMatch("a**b", "ab"));
    assert.ok(globMatch("ab*ba", "aba") === false, "prefix and suffix may not overlap");
    assert.ok(globMatch("*a*b*", "xxaxxbxx"));
    assert.ok(!globMatch("*a*b*", "xxbxxaxx"));
  });
});

describe("address ranges", () => {
  const range = (s: string) => {
    const r = parseRange(s);
    assert.ok(!("error" in r), s);
    return r;
  };
  it("prints the canonical form", () => {
    assert.equal(formatRange(range("10.1.2.3/8")), "10.0.0.0/8");
    assert.equal(formatRange(range("::")), "::");
    assert.equal(formatRange(range("2001:db8::")), "2001:db8::");
    assert.equal(formatRange(range("0:0:1::1")), "0:0:1::1");
    assert.equal(formatRange(range("2001:db8:0:1:1:1:1:1")), "2001:db8:0:1:1:1:1:1", "a single zero group is not ::");
  });
  it("checks membership across forms of the same client", () => {
    const r = range("198.51.100.0/22");
    assert.ok(inRange(r, "198.51.103.255"));
    assert.ok(inRange(r, "::ffff:198.51.101.1"));
    assert.ok(!inRange(r, "198.51.104.0"));
    assert.ok(!inRange(r, "2001:db8::1"));
    assert.ok(!inRange(r, "not-an-ip"));
    assert.ok(inRange(range("2001:db8::/32"), "2001:DB8:ffff::1"));
  });
  it("refuses what does not parse, with a sentence", () => {
    for (const bad of ["1.2.3.4/33", "1.2.3.4/x", "1.2.3/24", "2001:db8::/129", "1.2.3.4/8/9"]) assert.ok("error" in parseRange(bad), bad);
  });
});
