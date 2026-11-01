import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { count, gauge, histogram, readGauges, realtimeFactor, resetMetricsForTest, setMetricSink, type MetricAttributes } from "../src/metrics.js";
import { createYtdlpProxyPool, type ProxyCandidate } from "../src/ytdlp-proxy.js";
import { recordDownload } from "../src/pipeline/ingest.js";
import { sentryUnit } from "../src/telemetry.js";

type Row = { kind: string; name: string; value: number; unit: string; attributes: MetricAttributes };
let rows: Row[] = [];

beforeEach(() => {
  resetMetricsForTest();
  rows = [];
  setMetricSink({
    count: (name, value, unit, attributes) => rows.push({ kind: "count", name, value, unit, attributes }),
    distribution: (name, value, unit, attributes) => rows.push({ kind: "distribution", name, value, unit, attributes }),
    gauge: (name, value, unit, attributes) => rows.push({ kind: "gauge", name, value, unit, attributes }),
  });
});
afterEach(() => resetMetricsForTest());

const named = (name: string) => rows.filter((r) => r.name === name);

describe("metrics facade", () => {
  it("forwards to the sink and drops values that are not numbers", () => {
    histogram("x.duration", 1.5, "s", { stage: "render" });
    histogram("x.duration", Number.NaN, "s");
    count("x.count", 2, "{job}", { queue: "q" });
    count("x.count", -1);
    assert.deepEqual(rows, [
      { kind: "distribution", name: "x.duration", value: 1.5, unit: "s", attributes: { stage: "render" } },
      { kind: "count", name: "x.count", value: 2, unit: "{job}", attributes: { queue: "q" } },
    ]);
  });

  it("a sink that throws does not reach the caller", () => {
    setMetricSink({
      count: () => {
        throw new Error("sink down");
      },
      distribution: () => {
        throw new Error("sink down");
      },
      gauge: () => {},
    });
    assert.doesNotThrow(() => histogram("x", 1, "s"));
    assert.doesNotThrow(() => count("y"));
  });

  it("reads registered gauges once per name, and a failing gauge reads as empty", () => {
    gauge("g.one", "{job}", () => [[3, { queue: "render" }]]);
    gauge("g.one", "{job}", () => [[99, {}]]);
    gauge("g.bad", "1", () => {
      throw new Error("boom");
    });
    assert.deepEqual(readGauges(), [
      { name: "g.one", unit: "{job}", readings: [[3, { queue: "render" }]] },
      { name: "g.bad", unit: "1", readings: [] },
    ]);
  });

  it("realtime factor is work seconds per media second, null without a length", () => {
    assert.equal(realtimeFactor(30, 60), 0.5);
    assert.equal(realtimeFactor(30, 0), null);
    assert.equal(realtimeFactor(30, null), null);
    assert.equal(realtimeFactor(-1, 60), null);
  });

  it("maps OTel units to Sentry's names", () => {
    assert.equal(sentryUnit("s"), "second");
    assert.equal(sentryUnit("By/s"), "byte/second");
    assert.equal(sentryUnit("1"), "ratio");
    assert.equal(sentryUnit("{token}"), "token");
    assert.equal(sentryUnit("USD"), "USD");
  });
});

describe("proxy metrics", () => {
  const pi: ProxyCandidate = { id: "pi", url: "socks5h://pi.example:1080", priority: 200, concurrency: 0 };
  const paid: ProxyCandidate = { id: "paid", url: "http://gw.example:823", priority: 100, concurrency: 1 };

  it("counts each attempt by proxy and outcome, and the download by the proxy that served it", async () => {
    const pool = createYtdlpProxyPool([pi, paid], { faultsBeforeOpen: 2, halfOpenAfter: 60_000 });
    const out = await pool.run(async ({ id }) => {
      if (id === "pi") throw new Error("ERROR: Sign in to confirm you're not a bot");
      return id;
    });
    assert.equal(out.id, "paid");
    assert.deepEqual(
      named("reelsaw.ytdlp.attempts").map((r) => r.attributes),
      [
        { proxy: "pi", outcome: "proxy", panic: false },
        { proxy: "paid", outcome: "ok", panic: false },
      ],
    );
    assert.equal(named("reelsaw.ytdlp.attempt.duration").length, 2);
    const [download] = named("reelsaw.ytdlp.download.duration");
    assert.deepEqual(download?.attributes, { proxy: "paid", outcome: "ok", fallback: true });
    assert.equal(download?.unit, "s");
  });

  it("a content error is the video's, not the proxy's", async () => {
    const pool = createYtdlpProxyPool([pi, paid], { faultsBeforeOpen: 2, halfOpenAfter: 60_000 });
    await assert.rejects(() =>
      pool.run(async () => {
        throw new Error("ERROR: This video is private");
      }),
    );
    assert.deepEqual(
      named("reelsaw.ytdlp.attempts").map((r) => r.attributes.outcome),
      ["content"],
    );
    assert.deepEqual(named("reelsaw.ytdlp.download.duration")[0]?.attributes, { proxy: "none", outcome: "content", fallback: false });
  });

  it("reports circuit changes and per-proxy health, in-flight and success-rate gauges", async () => {
    const pool = createYtdlpProxyPool([pi, paid], { faultsBeforeOpen: 1, halfOpenAfter: 60_000 });
    await pool.run(async ({ id }) => {
      if (id === "pi") throw new Error("HTTP Error 403");
      return id;
    });
    assert.deepEqual(
      named("reelsaw.ytdlp.proxy.circuit.changes").map((r) => r.attributes),
      [{ proxy: "pi", state: "open" }],
    );
    const g = Object.fromEntries(readGauges().map((x) => [x.name, x.readings]));
    assert.deepEqual(g["reelsaw.ytdlp.proxy.healthy"], [
      [0, { proxy: "pi" }],
      [1, { proxy: "paid" }],
    ]);
    assert.deepEqual(g["reelsaw.ytdlp.proxy.in_flight"], [
      [0, { proxy: "pi" }],
      [0, { proxy: "paid" }],
    ]);
    assert.deepEqual(g["reelsaw.ytdlp.proxy.success_rate"], [
      [0, { proxy: "pi" }],
      [1, { proxy: "paid" }],
    ]);
  });

  it("normalises a download by the video's length and size", () => {
    recordDownload("paid", 120, 600, 60_000_000);
    assert.deepEqual(
      rows.map((r) => [r.name, r.value, r.attributes]),
      [
        ["reelsaw.ytdlp.download.realtime_factor", 0.2, { proxy: "paid" }],
        ["reelsaw.ytdlp.download.throughput", 500_000, { proxy: "paid" }],
      ],
    );
  });
});
