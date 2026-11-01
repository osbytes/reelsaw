/** runsOf: grouping a project's events into runs, durations as payload facts, fallbacks for old logs. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { firstStageSeconds, runsOf, type LogEvent } from "../src/pipeline/runs.js";

const T0 = Date.parse("2026-10-17T10:00:00Z");
const at = (sec: number, type: string, payload: Record<string, unknown> = {}): LogEvent => ({ type, payload, createdAt: new Date(T0 + sec * 1000) });

/** a full first run as the server writes it now: 0 → 95 s */
const firstRun = (): LogEvent[] => [
  at(0, "project.created", { title: "T" }),
  at(0, "run.started", { seq: 1, reason: "created" }),
  at(1, "stage.started", { stage: "ingest" }),
  at(11, "stage.completed", { stage: "ingest", durationSec: 10 }),
  at(11, "stage.started", { stage: "transcribe" }),
  at(41, "stage.completed", { stage: "transcribe", durationSec: 30 }),
  at(41, "stage.started", { stage: "refine" }),
  at(51, "stage.completed", { stage: "refine", durationSec: 10 }),
  at(51, "stage.started", { stage: "analyze" }),
  at(71, "stage.completed", { stage: "analyze", durationSec: 20 }),
  at(95, "project.done", { clips: 9, failed: 0, runSeq: 1, runReason: "created", runSec: 95, renderSec: 24 }),
];

describe("runsOf", () => {
  it("one run: reason, stages, render, outcome", () => {
    const [r, ...rest] = runsOf(firstRun());
    assert.equal(rest.length, 0);
    assert.equal(r!.seq, 1);
    assert.equal(r!.reason, "created");
    assert.equal(r!.outcome, "done");
    assert.equal(r!.runSec, 95);
    assert.deepEqual(r!.stages, { ingest: 10, transcribe: 30, refine: 10, analyze: 20, render: 24 });
    assert.deepEqual(r!.clips, { done: 9, failed: 0 });
  });

  it("a re-render an hour later is its own run with its own time (not 1 h 35)", () => {
    const log = [
      ...firstRun(),
      at(3695, "run.started", { seq: 2, reason: "rerender" }),
      at(3695, "clip.rendering", {}),
      at(3736, "project.done", { clips: 9, failed: 0, runSeq: 2, runReason: "rerender", runSec: 41, renderSec: 41 }),
    ];
    const runs = runsOf(log);
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.seq, 2);
    assert.equal(runs[1]!.reason, "rerender");
    assert.equal(runs[1]!.runSec, 41);
    assert.equal(runs[1]!.startedAt, new Date(T0 + 3695_000).toISOString());
    // the first run is untouched, and history for estimates reads each stage from the first run that had it
    assert.equal(runs[0]!.runSec, 95);
    assert.deepEqual(firstStageSeconds(runs), { ingest: 10, transcribe: 30, refine: 10, analyze: 20, render: 24 });
  });

  it("a retry after failure: failed run, then a retry run that finishes", () => {
    const log = [
      at(0, "project.created"),
      at(0, "run.started", { seq: 1, reason: "created" }),
      at(1, "stage.started", { stage: "ingest" }),
      at(5, "stage.failed", { stage: "ingest", error: "boom", attempt: 3, max: 3, durationSec: 4 }),
      at(5, "project.failed", { stage: "ingest", error: "boom", runSeq: 1, runReason: "created", runSec: 5 }),
      at(600, "run.started", { seq: 2, reason: "retry" }),
      at(601, "stage.started", { stage: "ingest" }),
      at(611, "stage.completed", { stage: "ingest", durationSec: 10 }),
      at(640, "project.done", { clips: 3, failed: 1, runSeq: 2, runReason: "retry", runSec: 40 }),
    ];
    const runs = runsOf(log);
    assert.deepEqual(
      runs.map((r) => [r.seq, r.reason, r.outcome, r.runSec]),
      [
        [1, "created", "failed", 5],
        [2, "retry", "done", 40],
      ],
    );
    assert.equal(runs[0]!.error, "boom");
    assert.deepEqual(runs[1]!.clips, { done: 3, failed: 1 });
    assert.deepEqual(runs[1]!.stages, { ingest: 10 });
  });

  it("a run still going has no finish and no total", () => {
    const [r] = runsOf([at(0, "run.started", { seq: 1, reason: "created" }), at(1, "stage.started", { stage: "ingest" })]);
    assert.equal(r!.outcome, "running");
    assert.equal(r!.runSec, null);
    assert.equal(r!.finishedAt, null);
  });

  it("a stage's reported time is capped by the wall clock around it (ingest once reported the video's length)", () => {
    const log = [
      at(0, "project.created", { title: "T" }),
      at(0, "run.started", { seq: 1, reason: "created" }),
      at(1, "stage.started", { stage: "ingest" }),
      at(241, "stage.completed", { stage: "ingest", durationSec: 5848 }), // 4 min download, 1:37:28 video
      at(241, "stage.started", { stage: "transcribe" }),
      at(541, "stage.completed", { stage: "transcribe", durationSec: 299.6 }), // precise clock stays when it fits
      at(600, "project.done", { clips: 3, failed: 0, runSeq: 1, runReason: "created", runSec: 600 }),
    ];
    const run = runsOf(log)[0]!;
    assert.equal(run.stages.ingest, 240);
    assert.equal(run.stages.transcribe, 299.6);
  });

  it("old events without durationSec or run.started still give durations and runs", () => {
    const log = [
      at(0, "project.created", { title: "old" }),
      at(1, "stage.started", { stage: "ingest" }),
      at(11, "stage.completed", { stage: "ingest" }),
      at(11, "stage.started", { stage: "analyze" }),
      at(41, "stage.completed", { stage: "analyze" }),
      at(65, "project.done", { clips: 4, failed: 0 }),
      // an hour later a re-render, in the old log style: no run.started, just clip events
      at(3700, "clip.rendering", {}),
      at(3740, "project.done", { clips: 4, failed: 0 }),
    ];
    const runs = runsOf(log);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.reason, "created");
    assert.equal(runs[0]!.runSec, 65);
    assert.deepEqual(runs[0]!.stages, { ingest: 10, analyze: 30, render: 24 });
    assert.equal(runs[1]!.reason, null);
    assert.equal(runs[1]!.runSec, 40);
    assert.deepEqual(firstStageSeconds(runs), { ingest: 10, analyze: 30, render: 24 });
  });
});
