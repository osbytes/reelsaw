/**
 * Quota refusal CTAs: upgrade when a next plan exists, request more capacity on the top plan,
 * free space as the other action on storage. No database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deletedProjectsPath } from "@reelsaw/shared";
import { checkJobLimits, QuotaExceededError, quotaRefusal, upgradeCapacityLabel, type Grants, type Limits, type LimitsDetail } from "../src/quota.js";

const limits = {
  MAX_PROJECTS_PER_USER: 10,
  MAX_SOURCE_MINUTES_PER_DAY: 0,
  MAX_SOURCE_MINUTES_PER_MONTH: 20,
  MAX_NEW_PROJECTS_PER_HOUR: 0,
  MAX_LIVE_JOBS_PER_USER: 2,
  MAX_RERENDERS_PER_HOUR: 0,
  MAX_STORAGE_MB: 2048,
  MAX_REQUESTS_PER_MINUTE: 0,
  MAX_REQUESTS_PER_HOUR: 0,
} satisfies Limits;

const source = Object.fromEntries(Object.keys(limits).map((k) => [k, "plan"])) as LimitsDetail["source"];

const starterUpgrade = {
  text: "Starter gives 100 minutes a month",
  url: "https://app.example.com/settings/billing",
  plan: "starter",
  planLabel: "Starter",
  limits: { MAX_SOURCE_MINUTES_PER_MONTH: 100, MAX_STORAGE_MB: 10240, MAX_PROJECTS_PER_USER: 50 },
};

const freeGrants: Grants = {
  plan: "free",
  planLabel: "Free",
  limits: { MAX_SOURCE_MINUTES_PER_MONTH: 20, MAX_STORAGE_MB: 2048, MAX_PROJECTS_PER_USER: 10 },
  watermark: null,
  period: null,
  upgrade: starterUpgrade,
};

const proGrants: Grants = {
  plan: "pro",
  planLabel: "Pro",
  limits: { MAX_SOURCE_MINUTES_PER_MONTH: 750, MAX_STORAGE_MB: 102400, MAX_PROJECTS_PER_USER: 0 },
  watermark: false,
  period: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") },
};

describe("quotaRefusal", () => {
  it("storage on Free: upgrade is primary, free space is secondary", () => {
    const r = quotaRefusal({ limits, source, plan: "free", grants: freeGrants }, "MAX_STORAGE_MB");
    assert.equal(r.primary?.kind, "upgrade");
    assert.match(r.primary && r.primary.kind === "upgrade" ? r.primary.label : "", /Starter gives 10 GB of storage/);
    assert.equal(r.secondary?.kind, "free_space");
    assert.equal(r.secondary && r.secondary.kind === "free_space" ? r.secondary.href : "", deletedProjectsPath());
  });
  it("minutes on Free: upgrade is primary, no free-space action", () => {
    const r = quotaRefusal({ limits, source, plan: "free", grants: freeGrants }, "MAX_SOURCE_MINUTES_PER_MONTH");
    assert.equal(r.primary?.kind, "upgrade");
    assert.match(r.primary && r.primary.kind === "upgrade" ? r.primary.label : "", /Starter gives 100 minutes a month/);
    assert.equal(r.secondary, undefined);
  });
  it("storage on Pro (no next plan): request more capacity is primary, free space is secondary", () => {
    const r = quotaRefusal({ limits, source, plan: "pro", grants: proGrants }, "MAX_STORAGE_MB");
    assert.deepEqual(r.primary, { kind: "request", label: "Request more capacity" });
    assert.equal(r.secondary?.kind, "free_space");
  });
  it("self-host (no grants): storage offers free space only", () => {
    const r = quotaRefusal({ limits, source, plan: null, grants: null }, "MAX_STORAGE_MB");
    assert.deepEqual(r.primary, { kind: "free_space", label: "Free space", href: deletedProjectsPath() });
    assert.equal(r.secondary, undefined);
  });
  it("self-host job limits have no product CTA", () => {
    const r = quotaRefusal({ limits, source, plan: null, grants: null }, "MAX_LIVE_JOBS_PER_USER");
    assert.equal(r.primary, undefined);
    assert.equal(r.secondary, undefined);
  });
});

describe("upgradeCapacityLabel", () => {
  it("names the next plan's storage and minutes", () => {
    assert.equal(upgradeCapacityLabel(starterUpgrade, "MAX_STORAGE_MB"), "Starter gives 10 GB of storage");
    assert.equal(upgradeCapacityLabel(starterUpgrade, "MAX_SOURCE_MINUTES_PER_MONTH"), "Starter gives 100 minutes a month");
    assert.equal(upgradeCapacityLabel(starterUpgrade, "MAX_PROJECTS_PER_USER"), "Starter gives 50 projects");
  });
});

describe("job limits", () => {
  it("the hourly cap names re-renders and re-runs", () => {
    const l = { ...limits, MAX_RERENDERS_PER_HOUR: 5, MAX_LIVE_JOBS_PER_USER: 0 };
    assert.throws(() => checkJobLimits(l, { userId: "u", live: 0, userLive: 0, userRendersLastHour: 5 }, true), /5 re-renders and re-runs requested in the last hour/);
    assert.doesNotThrow(() => checkJobLimits(l, { userId: "u", live: 0, userLive: 0, userRendersLastHour: 5 }, false));
  });
  it("the at-once cap counts only what the user asked for, not the pipeline's own jobs", () => {
    const l = { ...limits, MAX_RERENDERS_PER_HOUR: 0, MAX_LIVE_JOBS_PER_USER: 5 };
    // a new project's 20 renders are hand-offs: the user's next request still goes through
    assert.doesNotThrow(() => checkJobLimits(l, { userId: "u", live: 20, userLive: 1, userRendersLastHour: 0 }, false));
    assert.throws(() => checkJobLimits(l, { userId: "u", live: 20, userLive: 5, userRendersLastHour: 0 }, false), /You have 5 requests queued or running, the most this account may have at once \(5\)/);
  });
});

describe("QuotaExceededError", () => {
  it("is an Error the stage worker can tell from a fault", () => {
    const e = new QuotaExceededError("This video is 90 minutes.");
    assert.ok(e instanceof Error);
    assert.equal(e.message, "This video is 90 minutes.");
  });
});
