/**
 * Report zip vs feedback policy (report/capabilities.ts): no docker needed.
 * Run: pnpm --filter @reelsaw/server exec node --import tsx --test test/report-capabilities.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyReportInclude, reportCapabilities } from "../src/report/capabilities.js";

const tel = (sentry: boolean, posthog: boolean) => ({ enabled: { sentry, posthog } });
const ee = { billing: true } as never;
const inc = { logs: true, system: true, instance: false, previews: true, allClips: false, source: false };

describe("reportCapabilities", () => {
  it("self-host: zip + system for everyone; instance only for admins; feedback follows telemetry", () => {
    const off = reportCapabilities({ ee: null, telemetry: tel(false, false) }, { role: "user" });
    assert.deepEqual(off, { zip: true, system: true, instance: false, feedback: false });
    const on = reportCapabilities({ ee: null, telemetry: tel(true, false) }, { role: "user" });
    assert.deepEqual(on, { zip: true, system: true, instance: false, feedback: true });
    const admin = reportCapabilities({ ee: null, telemetry: tel(false, false) }, { role: "admin" });
    assert.deepEqual(admin, { zip: true, system: true, instance: true, feedback: false });
  });

  it("hosted non-admin with telemetry: feedback only, no system, no instance", () => {
    const caps = reportCapabilities({ ee, telemetry: tel(true, true) }, { role: "user" });
    assert.deepEqual(caps, { zip: false, system: false, instance: false, feedback: true });
  });

  it("hosted non-admin without telemetry: zip without system or instance", () => {
    const caps = reportCapabilities({ ee, telemetry: tel(false, false) }, { role: "user" });
    assert.deepEqual(caps, { zip: true, system: false, instance: false, feedback: false });
  });

  it("hosted admin: zip + system + instance, and feedback when telemetry is on", () => {
    const caps = reportCapabilities({ ee, telemetry: tel(false, true) }, { role: "admin" });
    assert.deepEqual(caps, { zip: true, system: true, instance: true, feedback: true });
  });

  it("applyReportInclude forces system and instance off when disallowed", () => {
    assert.equal(applyReportInclude({ zip: true, system: false, instance: false, feedback: false }, inc).system, false);
    assert.equal(applyReportInclude({ zip: true, system: true, instance: false, feedback: false }, inc).system, true);
    const asked = { ...inc, instance: true, system: false };
    const user = applyReportInclude({ zip: true, system: true, instance: false, feedback: false }, asked);
    assert.equal(user.instance, false);
    assert.equal(user.system, false);
    const admin = applyReportInclude({ zip: true, system: true, instance: true, feedback: false }, asked);
    assert.equal(admin.instance, true);
    assert.equal(admin.system, true, "instance implies system");
  });
});
