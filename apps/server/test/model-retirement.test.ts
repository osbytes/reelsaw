/** Model retirements (ai/retirement.ts): each provider's listing fields, the status at a given day, and the in-use check. Pure; no stack needed. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CatalogProvider } from "../src/ai/catalog.js";
import {
  anthropicRetirement,
  createModelLifecycle,
  describeModelInUse,
  expirationRetirement,
  gatewayRetirement,
  LIFECYCLE_CACHE_MS,
  lifecycleOf,
  listsExpiration,
  openAiRetirement,
  retirementStatus,
} from "../src/ai/retirement.js";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

describe("provider listing fields", () => {
  it("OpenAI: shutdown_date, null until announced", () => {
    assert.deepEqual(openAiRetirement({ id: "gpt-4o-mini", shutdown_date: "2027-01-14" }), { retiresAt: "2027-01-14T00:00:00.000Z", replacement: null });
    assert.equal(openAiRetirement({ id: "gpt-6-luna", shutdown_date: null }), undefined);
    assert.equal(openAiRetirement({ id: "old-listing" }), undefined);
  });

  it("Anthropic: retires_at, or deprecated with no date yet; active models say nothing", () => {
    assert.deepEqual(anthropicRetirement({ lifecycle: "deprecated", retires_at: "2027-03-01T00:00:00Z" }), {
      retiresAt: "2027-03-01T00:00:00.000Z",
      replacement: null,
    });
    assert.deepEqual(anthropicRetirement({ lifecycle: "deprecated", retires_at: null }), { retiresAt: null, replacement: null });
    assert.equal(anthropicRetirement({ lifecycle: "active", retires_at: null, deprecated_at: null }), undefined);
    // a listing from before the fields existed
    assert.equal(anthropicRetirement({ id: "claude-x", display_name: "Claude X" }), undefined);
  });

  it("OpenRouter expiration_date and the AI Gateway's deprecated_at (milliseconds)", () => {
    assert.equal(expirationRetirement({ id: "a", expiration_date: "2027-02-01" })?.retiresAt, "2027-02-01T00:00:00.000Z");
    assert.equal(expirationRetirement({ id: "a", expiration_date: null }), undefined);
    assert.equal(gatewayRetirement({ id: "openai/whisper-1", deprecated_at: 1803600000000 })?.retiresAt, "2027-02-26T00:00:00.000Z");
    assert.equal(gatewayRetirement({ id: "openai/gpt-4o-mini" }), undefined);
    assert.equal(gatewayRetirement({ id: "x", deprecated_at: "not a date" }), undefined);
  });

  it("a compatible server publishes dates only when its listing has the key", () => {
    assert.equal(listsExpiration([{ id: "a", expiration_date: null }]), true);
    assert.equal(listsExpiration([{ id: "llama3" }]), false);
    assert.equal(listsExpiration([]), false);
  });
});

describe("retirementStatus", () => {
  it("is retired on or after the date, soon within 30 days, scheduled after, deprecated without a date", () => {
    assert.deepEqual(retirementStatus({ retiresAt: day(-1), replacement: null }, NOW), { status: "retired", daysLeft: 0 });
    assert.deepEqual(retirementStatus({ retiresAt: day(0), replacement: null }, NOW), { status: "retired", daysLeft: 0 });
    assert.deepEqual(retirementStatus({ retiresAt: day(0.5), replacement: null }, NOW), { status: "soon", daysLeft: 1 });
    assert.deepEqual(retirementStatus({ retiresAt: day(30), replacement: null }, NOW), { status: "soon", daysLeft: 30 });
    assert.deepEqual(retirementStatus({ retiresAt: day(48), replacement: null }, NOW), { status: "scheduled", daysLeft: 48 });
    assert.deepEqual(retirementStatus({ retiresAt: null, replacement: null }, NOW), { status: "deprecated", daysLeft: null });
  });
});

const listing = (over: Partial<CatalogProvider> & Pick<CatalogProvider, "provider" | "models">): CatalogProvider => ({
  title: over.provider,
  kind: "language",
  available: true,
  source: "live",
  ...over,
});

describe("lifecycleOf", () => {
  const listings = {
    language: [
      listing({
        provider: "openai",
        title: "OpenAI",
        lifecycle: true,
        models: [
          { id: "openai:gpt-4o-mini", label: "gpt-4o-mini", retirement: { retiresAt: day(48), replacement: null } },
          { id: "openai:gpt-6-luna", label: "gpt-6-luna" },
        ],
      }),
      listing({ provider: "google", title: "Google", models: [{ id: "google:gemini-x", label: "gemini-x" }] }),
    ],
    transcription: [
      listing({
        provider: "openai",
        title: "OpenAI",
        kind: "transcription",
        lifecycle: true,
        models: [{ id: "openai:whisper-1", label: "whisper-1", retirement: { retiresAt: day(91), replacement: null } }],
      }),
    ],
  };

  it("joins the uses of one model, reads its retirement, and sorts the most urgent first", () => {
    const r = lifecycleOf(
      [
        { model: "openai:whisper-1", use: "transcription", kind: "transcription" },
        { model: "openai:whisper-1", use: "align", kind: "transcription" },
        { model: "google:gemini-x", use: "judge", kind: "language" },
        { model: "openai:gpt-4o-mini", use: "language", kind: "language" },
      ],
      listings,
      NOW,
    );
    assert.deepEqual(
      r.models.map((m) => [m.model, m.uses, m.retirement?.status ?? null, m.published]),
      [
        ["openai:gpt-4o-mini", ["language"], "scheduled", true],
        ["openai:whisper-1", ["transcription", "align"], "scheduled", true],
        ["google:gemini-x", ["judge"], null, false],
      ],
    );
    assert.equal(r.retiring, 2);
    assert.equal(r.worst, "scheduled");
    assert.equal(r.models[0]?.retirement?.daysLeft, 48);
  });

  it("a provider that could not be listed is unknown, not safe", () => {
    const r = lifecycleOf(
      [{ model: "anthropic:claude-x", use: "language", kind: "language" }],
      { language: [listing({ provider: "anthropic", title: "Anthropic", models: [], error: "cannot list Anthropic: HTTP 500" })], transcription: [] },
      NOW,
    );
    assert.equal(r.retiring, 0);
    assert.equal(r.models[0]?.error, "cannot list Anthropic: HTTP 500");
    const [only] = r.models;
    assert.ok(only);
    assert.match(describeModelInUse(only), /could not be listed/);
  });

  it("says plainly when a provider publishes no dates", () => {
    const r = lifecycleOf([{ model: "google:gemini-x", use: "language", kind: "language" }], listings, NOW);
    const [google] = r.models;
    assert.ok(google);
    assert.match(describeModelInUse(google), /no dates published by Google/);
    const soon = lifecycleOf([{ model: "openai:gpt-4o-mini", use: "language", kind: "language" }], listings, NOW + 20 * 86_400_000);
    assert.equal(soon.worst, "soon");
    const [mini] = soon.models;
    assert.ok(mini);
    assert.match(describeModelInUse(mini), /retires January 14, 2027 \(in 28 days\)/);
  });
});

describe("createModelLifecycle", () => {
  it("reads the listings once per window, again on refresh or when the models in use change", async () => {
    let lists = 0;
    let now = NOW;
    let models = { language: "openai:gpt-4o-mini", transcription: "openai:whisper-1", align: "openai:whisper-1" };
    const checker = createModelLifecycle({
      catalog: {
        list: async (kind) => {
          lists++;
          return kind === "language"
            ? [
                listing({
                  provider: "openai",
                  lifecycle: true,
                  models: [{ id: "openai:gpt-4o-mini", label: "gpt-4o-mini", retirement: { retiresAt: day(48), replacement: null } }],
                }),
              ]
            : [];
        },
      },
      models: { get: () => models },
      now: () => now,
    });
    await checker.get();
    await checker.get();
    assert.equal(lists, 2, "language + transcription, then cached");
    now += LIFECYCLE_CACHE_MS + 1;
    await checker.get();
    assert.equal(lists, 4);
    await checker.get({ refresh: true });
    assert.equal(lists, 6);
    models = { ...models, language: "openai:gpt-6-luna" };
    const r = await checker.get();
    assert.equal(lists, 8);
    assert.equal(r.retiring, 0);
  });
});
