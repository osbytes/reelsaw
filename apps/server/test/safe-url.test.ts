/** assertPublicHttpUrl: pure, no stack needed. Run: node --import tsx --test test/safe-url.test.ts */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isPrivateAddress, UnsafeUrlError } from "../src/lib/safe-url.js";

const pub = async () => [{ address: "93.184.216.34" }];
const rejects = (u: string, lookup = pub) => assert.rejects(assertPublicHttpUrl(u, { lookup }), UnsafeUrlError);

describe("safe-url", () => {
  it("accepts public http(s) hosts", async () => {
    await assertPublicHttpUrl("https://example.com/v?x=1", { lookup: pub });
    await assertPublicHttpUrl("http://93.184.216.34/a.mp4");
  });
  it("rejects other schemes and credentials", async () => {
    await rejects("file:///etc/passwd");
    await rejects("ftp://example.com/a");
    await rejects("https://user:pw@example.com/");
    await rejects("not a url");
  });
  it("rejects private literals", async () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "[::1]", "[fe80::1]", "[fd00::1]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[ff02::1]"]) await rejects(`http://${h}/`);
    assert.equal(isPrivateAddress("172.32.0.1"), false);
    assert.equal(isPrivateAddress("100.128.0.1"), false);
    assert.equal(isPrivateAddress("2606:4700::1111"), false);
  });
  it("rejects internal names and names resolving privately", async () => {
    for (const h of ["localhost", "foo.localhost", "host.docker.internal", "db.internal", "metadata.google.internal"]) await rejects(`http://${h}/`);
    await rejects("https://sneaky.example/", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }]);
    await rejects("https://nx.example/", async () => {
      throw new Error("ENOTFOUND");
    });
  });
  it("allowPrivate lifts the address check but not the scheme check", async () => {
    await assertPublicHttpUrl("http://192.168.1.10/a.mp4", { allowPrivate: true });
    await assert.rejects(assertPublicHttpUrl("file:///x", { allowPrivate: true }), UnsafeUrlError);
  });
});
