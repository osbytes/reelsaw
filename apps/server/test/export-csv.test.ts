import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "../src/export.js";

test("csvCell: text a spreadsheet would run as a formula gets a leading apostrophe", () => {
  for (const s of ["=HYPERLINK(\"http://evil\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
    assert.ok(csvCell(s).replace(/^"/, "").startsWith("'"), JSON.stringify(s));
  }
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("-dash, with comma"), '"\'-dash, with comma"');
});

test("csvCell: ordinary text, numbers and empties are unchanged; quoting is kept", () => {
  assert.equal(csvCell("A title"), "A title");
  assert.equal(csvCell("a=b"), "a=b");
  assert.equal(csvCell(-1.5), "-1.5");
  assert.equal(csvCell(12), "12");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
});
