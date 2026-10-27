/** assertPublicHttpUrl: pure, no stack needed. Run: node --import tsx --test test/safe-url.test.ts */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, fetchPublic, isPrivateAddress, TooManyRedirectsError, UnsafeUrlError } from "../src/lib/safe-url.js";

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

describe("safe-url: tunnels and reserved ranges", () => {
  it("blocks 6to4 and NAT64 addresses that embed a private IPv4, and the reserved IPv4 ranges", () => {
    for (const ip of ["2002:a00:1::1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1", "198.18.0.1", "198.19.255.1", "192.0.0.8"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });
  it("allows 6to4 and NAT64 addresses that embed a public IPv4, and neighbouring public IPv4", () => {
    for (const ip of ["2002:5db8:d822::1", "64:ff9b::5db8:d822", "198.20.0.1", "198.17.255.1", "192.1.0.1"]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
});

describe("fetchPublic", () => {
  const ok = () => new Response("x");
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  it("connects to the address it validated, and follows redirects hop by hop", async () => {
    const seen: Array<[string, string | null]> = [];
    const { res, url } = await fetchPublic("https://a.example/start", {
      lookup: async () => [{ address: "93.184.216.34" }],
      fetch: async (u, _init, pinned) => {
        seen.push([u.toString(), pinned]);
        return seen.length === 1 ? redirect("/next") : ok();
      },
    });
    assert.equal(res.status, 200);
    assert.equal(url.toString(), "https://a.example/next");
    assert.deepEqual(seen, [["https://a.example/start", "93.184.216.34"], ["https://a.example/next", "93.184.216.34"]]);
  });
  it("refuses a redirect to an internal address and a loop of redirects", async () => {
    await assert.rejects(fetchPublic("https://a.example/", { lookup: pub, fetch: async () => redirect("http://169.254.169.254/latest") }), UnsafeUrlError);
    await assert.rejects(fetchPublic("https://a.example/", { lookup: pub, maxRedirects: 2, fetch: async () => redirect("/again") }), TooManyRedirectsError);
  });
  it("refuses a name whose answer includes a private address, before any request", async () => {
    let called = false;
    await assert.rejects(
      fetchPublic("https://rebind.example/", {
        lookup: async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }],
        fetch: async () => {
          called = true;
          return ok();
        },
      }),
      UnsafeUrlError,
    );
    assert.equal(called, false);
  });
});
