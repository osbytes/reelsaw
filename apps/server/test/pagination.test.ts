import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor, escapeLike, pageOf } from "../src/pagination.js";

describe("pagination helpers", () => {
  it("round-trips a cursor tuple", () => {
    const c = encodeCursor(["2026-10-17 12:00:00.123456+00", "abc-1", 7]);
    assert.match(c, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCursor(c, 3), ["2026-10-17 12:00:00.123456+00", "abc-1", 7]);
  });

  it("rejects garbage, wrong arity and wrong types", () => {
    assert.equal(decodeCursor("not a cursor!!", 2), null);
    assert.equal(decodeCursor(encodeCursor(["a"]), 2), null);
    assert.equal(decodeCursor(Buffer.from('{"a":1}').toString("base64url"), 1), null);
    assert.equal(decodeCursor(Buffer.from('[null,"x"]').toString("base64url"), 2), null);
    assert.equal(decodeCursor("", 1), null);
  });

  it("escapes LIKE wildcards and the escape character", () => {
    assert.equal(escapeLike("50%_off"), "50\\%\\_off");
    assert.equal(escapeLike("a\\b"), "a\\\\b");
    assert.equal(escapeLike("plain"), "plain");
  });

  it("pages: next cursor only when a row beyond the limit exists", () => {
    const rows = [1, 2, 3];
    assert.deepEqual(pageOf(rows, 3, (n) => [n]), { items: [1, 2, 3], nextCursor: null });
    const more = pageOf(rows, 2, (n) => [n]);
    assert.deepEqual(more.items, [1, 2]);
    assert.deepEqual(decodeCursor(more.nextCursor!, 1), [2]);
  });
});
