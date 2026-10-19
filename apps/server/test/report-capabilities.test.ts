/**
 * Report zip vs feedback policy (report/capabilities.ts): no docker needed.
 * Run: pnpm --filter @reelsaw/server exec node --import tsx --test test/report-capabilities.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyReportInclude, reportCapabilities } from "../src/report/capabilities.js";

const tel = (sentry: boolean, posthog: boolean) => ({ enabled: { sentry, posthog } });
const ee = { billing: true } as never;

describe("reportCapabilities", () => {
  it("self-host: zip + system for everyone; feedback follows telemetry", () => {
    const off = reportCapabilities({ ee: null, telemetry: tel(false, false) }, { role: "user" });
    assert.deepEqual(off, { zip: true, system: true, feedback: false });
    const on = reportCapabilities({ ee: null, telemetry: tel(true, false) }, { role: "user" });
    assert.deepEqual(on, { zip: true, system: true, feedback: true });
  });

  it("hosted non-admin with telemetry: feedback only, no system", () => {
    const caps = reportCapabilities({ ee, telemetry: tel(true, true) }, { role: "user" });
    assert.deepEqual(caps, { zip: false, system: false, feedback: true });
  });

  it("hosted non-admin without telemetry: zip without system", () => {
    const caps = reportCapabilities({ ee, telemetry: tel(false, false) }, { role: "user" });
    assert.deepEqual(caps, { zip: true, system: false, feedback: false });
  });

  it("hosted admin: zip + system, and feedback when telemetry is on", () => {
    const caps = reportCapabilities({ ee, telemetry: tel(false, true) }, { role: "admin" });
    assert.deepEqual(caps, { zip: true, system: true, feedback: true });
  });

  it("applyReportInclude forces system off when disallowed", () => {
    const inc = { logs: true, system: true, previews: true, allClips: false, source: false };
    assert.equal(applyReportInclude({ zip: true, system: false, feedback: false }, inc).system, false);
    assert.equal(applyReportInclude({ zip: true, system: true, feedback: false }, inc).system, true);
  });
});
