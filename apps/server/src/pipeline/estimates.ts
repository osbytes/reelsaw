/**
 * Expected processing time per stage, learned from this instance's own finished projects.
 *
 * Every stage scales with the length of the source: seconds of work per second of video is a
 * "factor" that depends on the models (local vs vendor) and the machine. The factor for a stage is
 * the median over recent projects that ran with the same language + transcription models; until
 * such projects exist the README defaults apply (measured on one machine, see README "What to
 * expect"). There is no calibration step: the runs are the calibration.
 */
import { sql } from "drizzle-orm";
import { PIPELINE_STAGES, type PipelineStage } from "@reelsaw/shared";
import type { Db } from "../db/index.js";
import type { Config } from "../config.js";
import { providerOf } from "../ai/registry.js";

export type Factors = Record<PipelineStage, number>;

/**
 * README defaults, seconds of stage per second of source. "local" = CPU whisper + a 14B model on
 * an Apple-silicon laptop (first bench run: 20 min video → ingest 15 s, transcribe 4.9 min, refine
 * 10 min, analyze 4 min, render 47 s for 3 clips). "cloud" = vendor STT + a hosted LLM.
 */
export const DEFAULT_FACTORS: { local: Factors; cloud: Factors } = {
  local: { ingest: 0.015, transcribe: 0.25, refine: 0.5, analyze: 0.2, render: 0.04 },
  // measured 2026-10-17 on a 20-minute source, 3 clips (eval/bench/results/2026-10-17-initial): whisper-1 at 3 chunks in
  // flight ≈ 0.065, haiku/sonnet refine ≈ 0.026, analyze 0.02–0.07 by model, render ≈ 0.05 with a cloud align model
  cloud: { ingest: 0.015, transcribe: 0.065, refine: 0.03, analyze: 0.04, render: 0.05 },
};

/** Which model decides whether a stage runs "local" or "cloud" speed. */
const STAGE_MODEL: Record<PipelineStage, "language" | "transcription" | null> = { ingest: null, transcribe: "transcription", refine: "language", analyze: "language", render: null };

export interface Models {
  language: string;
  transcription: string;
}

/** A model id is local when it addresses a self-hosted OpenAI-compatible server. */
export function isLocalModel(id: string, config: Pick<Config, "OPENAI_BASE_URL" | "OPENAI_COMPATIBLE_NAME">): boolean {
  const p = providerOf(id);
  return p === config.OPENAI_COMPATIBLE_NAME || (p === "openai" && !!config.OPENAI_BASE_URL);
}

export function defaultFactors(models: Models, config: Pick<Config, "OPENAI_BASE_URL" | "OPENAI_COMPATIBLE_NAME">): Factors {
  const out = {} as Factors;
  for (const stage of PIPELINE_STAGES) {
    const which = STAGE_MODEL[stage];
    const local = which ? isLocalModel(models[which], config) : isLocalModel(models.language, config);
    out[stage] = (local ? DEFAULT_FACTORS.local : DEFAULT_FACTORS.cloud)[stage];
  }
  return out;
}

/** One finished project: how long each stage took and what ran. */
export interface StageSample {
  projectId: string;
  title: string;
  durationSec: number;
  finishedAt: string;
  models: Partial<Models>;
  /** seconds per stage; a stage that never completed is absent */
  stages: Partial<Record<PipelineStage, number>>;
}

/**
 * Does a past project count for `stage` under `models`? Only the model that drives the stage has
 * to match (transcription for transcribe, language for refine / analyze); download and render do
 * not depend on a model, so every finished project counts for them.
 */
export function comparable(stage: PipelineStage, past: Partial<Models>, models: Models): boolean {
  const which = STAGE_MODEL[stage];
  return !which || past[which] === models[which];
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface StageEstimate {
  stage: PipelineStage;
  expectedSec: number;
  source: "history" | "default";
  /** finished projects with the same models the factor came from (0 for a default) */
  samples: number;
}

/**
 * Expected seconds per stage for a source of `durationSec`: the median factor over `history`
 * entries that ran with `models`, per stage, falling back to the defaults stage by stage.
 */
export function estimateStages(durationSec: number, models: Models, history: StageSample[], defaults: Factors): StageEstimate[] {
  return PIPELINE_STAGES.map((stage) => {
    const factors = history.flatMap((h) => (h.durationSec > 0 && h.stages[stage] !== undefined && comparable(stage, h.models, models) ? [h.stages[stage]! / h.durationSec] : []));
    const f = factors.length ? median(factors) : defaults[stage];
    return { stage, expectedSec: Math.round(f * durationSec), source: factors.length ? "history" : "default", samples: factors.length };
  });
}

/** Stage seconds of finished projects, newest first, from their events and stage artifacts. */
export async function loadHistory(db: Db, limit = 40): Promise<StageSample[]> {
  const rows = (
    await db.execute(sql`
      with recent as (
        select id, title, duration_sec, updated_at from projects
        where status in ('done', 'failed') and duration_sec is not null and duration_sec > 0
        order by updated_at desc limit ${limit}
      ),
      -- the first run of each stage: a later refine / re-analyze on the same project must not stretch it
      stage_starts as (
        select e.project_id, e.payload->>'stage' as stage, min(e.created_at) as started
        from project_events e join recent r on r.id = e.project_id
        where e.type = 'stage.started' and e.payload ? 'stage'
        group by 1, 2
      ),
      stage_times as (
        select s.project_id, s.stage, s.started,
          (select min(c.created_at) from project_events c
            where c.project_id = s.project_id and c.type = 'stage.completed' and c.payload->>'stage' = s.stage and c.created_at > s.started) as completed
        from stage_starts s
      ),
      done_at as (
        select e.project_id, min(e.created_at) as at from project_events e join recent r on r.id = e.project_id where e.type = 'project.done' group by 1
      ),
      models as (
        select a.project_id, jsonb_object_agg(k, v) as models
        from stage_artifacts a join recent r on r.id = a.project_id, jsonb_each_text(a.models) as kv(k, v)
        where k in ('language', 'transcription') group by 1
      )
      select r.id, r.title, r.duration_sec, r.updated_at, m.models,
        coalesce(jsonb_object_agg(s.stage, extract(epoch from (s.completed - s.started))) filter (where s.stage is not null and s.completed is not null), '{}'::jsonb) as stages,
        (select at from done_at d where d.project_id = r.id) as done_at,
        (select completed from stage_times t where t.project_id = r.id and t.stage = 'analyze') as analyze_done
      from recent r
      left join stage_times s on s.project_id = r.id
      left join models m on m.project_id = r.id
      group by r.id, r.title, r.duration_sec, r.updated_at, m.models
      order by r.updated_at desc
    `)
  ).rows as Array<{ id: string; title: string; duration_sec: number | string; updated_at: Date | string; models: Partial<Models> | null; stages: Record<string, number | string>; done_at: Date | string | null; analyze_done: Date | string | null }>;
  // raw `execute` rows are not run through drizzle's column mappers: timestamps and numerics may be strings
  const when = (v: Date | string | null) => (v ? new Date(v).getTime() : null);
  return rows.map((r) => {
    const stages: Partial<Record<PipelineStage, number>> = {};
    for (const stage of PIPELINE_STAGES) {
      const sec = Number(r.stages?.[stage]);
      if (Number.isFinite(sec) && sec > 0) stages[stage] = Math.round(sec * 10) / 10;
    }
    // render has no stage.completed of its own: it runs per clip and ends with project.done
    const done = when(r.done_at);
    const analyzed = when(r.analyze_done);
    if (stages.render === undefined && done !== null && analyzed !== null && done > analyzed) stages.render = Math.round(((done - analyzed) / 1000) * 10) / 10;
    return { projectId: r.id, title: r.title, durationSec: Number(r.duration_sec), finishedAt: new Date(r.updated_at).toISOString(), models: r.models ?? {}, stages };
  });
}

export interface ProcessingTimes {
  models: Models;
  /** finished projects that count for at least one model-driven stage */
  samples: number;
  stages: Array<{
    stage: PipelineStage;
    /** seconds of work per second of source: median over the samples, or the default */
    factor: number;
    source: "history" | "default";
    samples: number;
    /** over the samples: mean actual seconds and what the factor would have predicted for them */
    actualAvgSec: number | null;
    expectedAvgSec: number | null;
  }>;
  recent: Array<{ projectId: string; title: string; durationSec: number; finishedAt: string; stages: Partial<Record<PipelineStage, { actualSec: number; expectedSec: number }>> }>;
}

/** The Settings → System view: learned factors, how they fit the recent projects, and those projects. */
export function processingTimes(models: Models, history: StageSample[], defaults: Factors): ProcessingTimes {
  const usable = history.filter((h) => h.durationSec > 0);
  const same = usable.filter((h) => (["transcribe", "refine", "analyze"] as const).some((s) => h.stages[s] !== undefined && comparable(s, h.models, models)));
  const stages = PIPELINE_STAGES.map((stage) => {
    const withStage = usable.filter((h) => h.stages[stage] !== undefined && comparable(stage, h.models, models));
    const factors = withStage.map((h) => h.stages[stage]! / h.durationSec);
    const factor = factors.length ? median(factors) : defaults[stage];
    const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    return {
      stage,
      factor: Number(factor.toFixed(4)),
      source: factors.length ? ("history" as const) : ("default" as const),
      samples: factors.length,
      actualAvgSec: mean(withStage.map((h) => h.stages[stage]!)),
      expectedAvgSec: mean(withStage.map((h) => factor * h.durationSec)),
    };
  });
  const byStage = Object.fromEntries(stages.map((s) => [s.stage, s.factor])) as Factors;
  return {
    models,
    samples: same.length,
    stages,
    recent: same.slice(0, 10).map((h) => ({
      projectId: h.projectId,
      title: h.title,
      durationSec: h.durationSec,
      finishedAt: h.finishedAt,
      // only the stages that ran with the current models are comparable; the others are left out
      stages: Object.fromEntries(
        Object.entries(h.stages)
          .filter(([stage]) => comparable(stage as PipelineStage, h.models, models))
          .map(([stage, actualSec]) => [stage, { actualSec, expectedSec: Math.round(byStage[stage as PipelineStage] * h.durationSec) }]),
      ),
    })),
  };
}
