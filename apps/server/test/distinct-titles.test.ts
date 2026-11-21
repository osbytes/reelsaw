/** Chunks are titled by separate model calls; the same title came back for several clips of one project. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distinctTitles } from "../src/pipeline/select.js";

describe("distinctTitles", () => {
  it("the first keeps its title, a repeat takes its own hook", () => {
    const out = distinctTitles([
      { title: "First Impressions of GTA 6", hook: "Wait, the map is HOW big?" },
      { title: "first impressions of GTA 6!", hook: "The cops here don't miss" },
      { title: "Driving Mechanics", hook: "This handling is unreal" },
    ]);
    assert.deepEqual(
      out.map((c) => c.title),
      ["First Impressions of GTA 6", "The cops here don't miss", "Driving Mechanics"],
    );
  });
  it("numbers a repeat whose hook is taken too, and avoids titles already on the project", () => {
    const out = distinctTitles(
      [
        { title: "Setting Up Environment Variables", hook: "Setting up environment variables" },
        { title: "Setting Up Environment Variables", hook: "" },
      ],
      ["Setting Up Environment Variables"],
    );
    assert.deepEqual(
      out.map((c) => c.title),
      ["Setting Up Environment Variables (2)", "Setting Up Environment Variables (3)"],
    );
  });
  it("leaves distinct titles alone (same objects)", () => {
    const xs = [
      { title: "A", hook: "a" },
      { title: "B", hook: "b" },
    ];
    const out = distinctTitles(xs);
    assert.equal(out[0], xs[0]);
    assert.equal(out[1], xs[1]);
  });
});
