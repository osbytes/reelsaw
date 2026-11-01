/**
 * The decision log (docs/specs/decision-log.md): every accept, reject, delete, manual fix and clip edit becomes one
 * append-only `user_decisions` row, written in the unit of work of the action it records, with the context needed to
 * judge it after the project is gone (a word window, the clip's text and the model's reasoning) and a snapshot of
 * the source. tRPC `decisions.*`, MCP `list_decisions` / `export_decisions` / `forget_decisions` and
 * `reelsaw decisions …` all call these.
 */
import { and, asc, count, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { DecisionKind, SourceRef, TranscriptFlag, TranscriptSegment, Word } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import { deadlineIn, keysetLoop } from "../lib/batch.js";
import { disfluencyCases, type ExportedDecision } from "./cases.js";

/** Words kept on each side of a fix: the window `eval/fixtures/disfluency` cases use. */
export const FIX_CONTEXT_WORDS = 30;
/** Clip transcript text kept with a clip decision. */
export const CLIP_TEXT_MAX = 4000;
export const LIST_MAX = 200;

type ProjectRef = Pick<schema.Project, "id" | "userId" | "sourceType" | "sourceUrl" | "sourceMeta" | "durationSec" | "title">;

export interface DecisionInput {
  kind: DecisionKind;
  /** default true: a person chose it */
  explicit?: boolean;
  clipId?: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: Record<string, unknown>;
  models?: Record<string, string>;
  /** backfill only: when it was decided */
  createdAt?: Date;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The source a project's timestamps refer to, as recorded at ingest (pipeline/ingest.ts). */
export function sourceRefOf(p: Pick<schema.Project, "sourceType" | "sourceUrl" | "sourceMeta" | "durationSec" | "title">): SourceRef {
  const m = p.sourceMeta ?? {};
  const ref: SourceRef = {
    type: p.sourceType,
    url: p.sourceType === "url" ? (str(m.webpage_url) ?? p.sourceUrl ?? undefined) : undefined,
    extractor: str(m.extractor),
    videoId: str(m.videoId),
    formatId: str(m.formatId),
    durationSec: p.durationSec ?? num(m.duration),
    sha256: str(m.sha256),
    title: str(m.title) ?? p.title,
    uploader: str(m.uploader),
  };
  return ref; // undefined keys are dropped when stored as jsonb
}

/** Whether this user's decisions are recorded (Settings → Learning; no settings row = on). */
export async function learningOn(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ on: schema.userSettings.learnFromDecisions }).from(schema.userSettings).where(eq(schema.userSettings.userId, userId));
  return row?.on ?? true;
}

/**
 * Append decisions about one project, in the caller's unit of work (pass `u.db`), so a rolled-back action records
 * nothing. Writes nothing when the owner turned learning off; `build` (the transcript and model reads behind the rows)
 * only runs when it is on. Returns how many rows were written.
 */
export async function recordDecisions(
  svc: Pick<Services, "config">,
  db: Db,
  project: ProjectRef,
  build: () => Promise<DecisionInput[]> | DecisionInput[],
): Promise<number> {
  if (!(await learningOn(db, project.userId))) return 0;
  const rows = await build();
  if (!rows.length) return 0;
  const source = sourceRefOf(project);
  await db.insert(schema.userDecisions).values(
    rows.map((r) => ({
      userId: project.userId,
      projectId: project.id,
      clipId: r.clipId ?? null,
      kind: r.kind,
      explicit: r.explicit ?? true,
      before: r.before,
      after: r.after,
      context: r.context,
      models: r.models ?? {},
      source,
      appVersion: svc.config.REELSAW_VERSION,
      ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    })),
  );
  return rows.length;
}

// ── fixes ──────────────────────────────────────────────────────────────────

/** The raw words around a fix, with the fix's position inside the window (the disfluency case shape). */
export function fixContext(raw: ReadonlyArray<Word>, f: Pick<TranscriptFlag, "wordIndex" | "span">) {
  const from = Math.max(0, f.wordIndex - FIX_CONTEXT_WORDS);
  const to = Math.min(raw.length, f.wordIndex + f.span + FIX_CONTEXT_WORDS);
  return {
    words: raw.slice(from, to).map((w) => ({ text: w.text, start: w.start, end: w.end })),
    target: { index: f.wordIndex - from, span: f.span },
    offset: from,
  };
}

/**
 * A fix as the decision stores it: everything but the flags a manual fix absorbed. Detector cuts a manual cut covers
 * get their own inferred fix.accept rows (`addManualFix`); the rest were decided before (their own rows) or are superseded.
 */
export function flagSnapshot(f: TranscriptFlag): Record<string, unknown> {
  const { absorbed: _absorbed, ...rest } = f;
  void _absorbed;
  return rest;
}

/** The refine (or transcribe) artifact that recorded which models proposed each kind of fix. */
const FLAG_ARTIFACT: Record<TranscriptFlag["kind"], { stage: string; kind: string }> = {
  entity: { stage: "refine", kind: "entities" },
  disfluency: { stage: "refine", kind: "disfluency" },
  loop: { stage: "transcribe", kind: "models" },
};

/** Models of the latest artifact of a stage, or {} when none was recorded. */
export async function stageModels(db: Db, projectId: string, stage: string, kind: string): Promise<Record<string, string>> {
  const [row] = await db
    .select({ models: schema.stageArtifacts.models })
    .from(schema.stageArtifacts)
    .where(and(eq(schema.stageArtifacts.projectId, projectId), eq(schema.stageArtifacts.stage, stage), eq(schema.stageArtifacts.kind, kind)))
    .orderBy(desc(schema.stageArtifacts.id))
    .limit(1);
  return row?.models ?? {};
}

/** Decision rows for fixes: context from the raw words, models from the stage that proposed each (none for manual ones). */
export async function fixDecisions(
  db: Db,
  projectId: string,
  raw: ReadonlyArray<Word>,
  items: Array<{
    kind: DecisionKind;
    flag: TranscriptFlag;
    before: TranscriptFlag | null;
    after: TranscriptFlag | null;
    createdAt?: Date;
    backfilled?: boolean;
    explicit?: boolean;
  }>,
): Promise<DecisionInput[]> {
  const models = new Map<string, Record<string, string>>();
  const out: DecisionInput[] = [];
  for (const it of items) {
    let m: Record<string, string> = {};
    if (it.flag.subkind !== "manual") {
      const a = FLAG_ARTIFACT[it.flag.kind];
      const key = `${a.stage}/${a.kind}`;
      if (!models.has(key)) models.set(key, await stageModels(db, projectId, a.stage, a.kind));
      m = models.get(key)!;
    }
    out.push({
      kind: it.kind,
      ...(it.explicit === false ? { explicit: false } : {}),
      before: it.before ? flagSnapshot(it.before) : null,
      after: it.after ? flagSnapshot(it.after) : null,
      context: {
        flagId: it.flag.id,
        flagKind: it.flag.kind,
        subkind: it.flag.subkind ?? null,
        ...fixContext(raw, it.flag),
        ...(it.backfilled ? { backfilled: true } : {}),
      },
      models: m,
      ...(it.createdAt ? { createdAt: it.createdAt } : {}),
    });
  }
  return out;
}

// ── clips ──────────────────────────────────────────────────────────────────

type ClipRow = schema.Clip;
/** The fields a decision keeps about a clip: what the model proposed (range, text, scores, reasoning) and the user's framing and style. */
export function clipSnapshot(c: ClipRow): Record<string, unknown> {
  return {
    startSec: c.startSec,
    endSec: c.endSec,
    title: c.title,
    hook: c.hook,
    caption: c.caption,
    hashtags: c.hashtags,
    score: c.score,
    scores: c.scores ?? null,
    reasoning: c.reasoning,
    origin: c.origin,
    index: c.index,
    status: c.status,
    edited: !!c.editedAt,
    layoutOverride: c.layoutOverride ?? null,
    layoutSections: c.layoutSections ?? null,
    style: c.style ?? null,
    emphasis: c.emphasis ?? null,
  };
}

/** The transcript text of each range, from the sentence list (one read of `segments`, never the words). */
export async function rangeTexts(db: Db, projectId: string, ranges: Array<{ startSec: number; endSec: number }>): Promise<string[]> {
  if (!ranges.length) return [];
  const [t] = await db.select({ segments: schema.transcripts.segments }).from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId));
  const segs: TranscriptSegment[] = t?.segments ?? [];
  return ranges.map((r) =>
    segs
      .filter((s) => s.end > r.startSec && s.start < r.endSec)
      .map((s) => s.text)
      .join(" ")
      .slice(0, CLIP_TEXT_MAX),
  );
}

/** Decision rows for whole clips (delete, restore, create, replaced): the clip as it was, its text and the analyze models. */
export async function clipDecisions(
  db: Db,
  projectId: string,
  kind: DecisionKind,
  clips: ClipRow[],
  o: { explicit?: boolean; side?: "before" | "after" } = {},
): Promise<DecisionInput[]> {
  if (!clips.length) return [];
  const texts = await rangeTexts(db, projectId, clips);
  const models = clips.some((c) => c.origin !== "manual") ? await stageModels(db, projectId, "analyze", "candidates") : {};
  const side = o.side ?? "before";
  return clips.map((c, i) => ({
    kind,
    explicit: o.explicit ?? true,
    clipId: c.id,
    before: side === "before" ? clipSnapshot(c) : null,
    after: side === "after" ? clipSnapshot(c) : null,
    context: { text: texts[i] ?? "", startSec: c.startSec, endSec: c.endSec, origin: c.origin },
    models: c.origin === "manual" ? {} : models,
  }));
}

/** Snapshot keys each `updateClip` change name covers (bumpers and layers are decoration, recorded by name only). */
const EDIT_FIELDS: Record<string, Array<keyof ReturnType<typeof clipSnapshot>>> = {
  bounds: ["startSec", "endSec"],
  title: ["title"],
  hook: ["hook"],
  caption: ["caption"],
  hashtags: ["hashtags"],
  layoutOverride: ["layoutOverride"],
  layoutSections: ["layoutSections"],
  style: ["style"],
  emphasis: ["emphasis"],
};

/** One `clip.edit` decision: only the changed fields, as they were and as they are now. */
export async function clipEditDecision(db: Db, projectId: string, before: ClipRow, after: ClipRow, changed: string[]): Promise<DecisionInput | null> {
  if (!changed.length) return null;
  const b = clipSnapshot(before);
  const a = clipSnapshot(after);
  const keys = changed.flatMap((c) => EDIT_FIELDS[c] ?? []);
  const pick = (s: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, s[k]]));
  const [text] = await rangeTexts(db, projectId, [before]);
  return {
    kind: "clip.edit",
    clipId: before.id,
    before: pick(b),
    after: pick(a),
    context: {
      fields: changed,
      text: text ?? "",
      startSec: before.startSec,
      endSec: before.endSec,
      origin: before.origin,
      score: before.score,
      reasoning: before.reasoning,
    },
    models: before.origin === "manual" ? {} : await stageModels(db, projectId, "analyze", "candidates"),
  };
}

// ── reading, forgetting, settings ──────────────────────────────────────────

/**
 * Decisions still meant to teach: not about a project the owner deleted with "forget what Reelsaw learned" (they go at
 * its purge; until then learning and exports skip them, and a restore brings them back). The list still shows them.
 */
const notBeingForgotten = sql`${schema.userDecisions.projectId} not in (select ${schema.projects.id} from ${schema.projects} where ${schema.projects.forgetDecisionsOnPurge})`;

export interface ListDecisionsInput {
  kind?: DecisionKind | undefined;
  projectId?: string | undefined;
  /** id of the last row of the previous page */
  cursor?: number | undefined;
  limit?: number;
}

/** One user's decisions, newest first, keyset-paginated. */
export async function listDecisions(db: Db, userId: string, input: ListDecisionsInput = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), LIST_MAX);
  const scope = and(
    eq(schema.userDecisions.userId, userId),
    input.kind ? eq(schema.userDecisions.kind, input.kind) : undefined,
    input.projectId ? eq(schema.userDecisions.projectId, input.projectId) : undefined,
  );
  const rows = await db
    .select()
    .from(schema.userDecisions)
    .where(and(scope, input.cursor ? lt(schema.userDecisions.id, input.cursor) : undefined))
    .orderBy(desc(schema.userDecisions.id))
    .limit(limit + 1);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(schema.userDecisions).where(scope);
  const items = rows.slice(0, limit).map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null, total: n };
}

/** What Settings → Learning shows: whether recording is on, how many decisions are kept, per kind. */
export async function decisionSummary(db: Db, userId: string) {
  const byKind = await db
    .select({ kind: schema.userDecisions.kind, n: count() })
    .from(schema.userDecisions)
    .where(eq(schema.userDecisions.userId, userId))
    .groupBy(schema.userDecisions.kind);
  const [{ projects } = { projects: 0 }] = await db
    .select({ projects: sql<number>`count(distinct ${schema.userDecisions.projectId})`.mapWith(Number) })
    .from(schema.userDecisions)
    .where(eq(schema.userDecisions.userId, userId));
  return {
    enabled: await learningOn(db, userId),
    total: byKind.reduce((s, r) => s + r.n, 0),
    projects,
    byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
  };
}

/** Delete a user's decisions: one project's (`projectId`) or all of them. Returns how many went. */
export async function forgetDecisions(db: Db, userId: string, o: { projectId?: string | undefined } = {}): Promise<number> {
  const gone = await db
    .delete(schema.userDecisions)
    .where(and(eq(schema.userDecisions.userId, userId), o.projectId ? eq(schema.userDecisions.projectId, o.projectId) : undefined))
    .returning({ id: schema.userDecisions.id });
  return gone.length;
}

/** Turn recording on or off; what is already recorded stays (forget it with `forgetDecisions`). */
export async function setLearning(db: Db, userId: string, enabled: boolean) {
  await db
    .insert(schema.userSettings)
    .values({ userId, learnFromDecisions: enabled })
    .onConflictDoUpdate({ target: schema.userSettings.userId, set: { learnFromDecisions: enabled, updatedAt: new Date() } });
  return { ok: true as const, enabled };
}

/**
 * Rejected detector cuts from the user's other projects, newest first: the "keep" examples the disfluency verifier sees.
 * Only rejections that still stand: a later decision on the same fix (accepted after all, deleted, restored) retracts one.
 */
export async function rejectedCutRows(db: Db, userId: string, exceptProjectId: string, max: number) {
  return db
    .select({ context: schema.userDecisions.context })
    .from(schema.userDecisions)
    .where(
      and(
        eq(schema.userDecisions.userId, userId),
        eq(schema.userDecisions.kind, "fix.reject"),
        notBeingForgotten,
        sql`${schema.userDecisions.projectId} <> ${exceptProjectId}`,
        sql`${schema.userDecisions.context}->>'flagKind' = 'disfluency'`,
        sql`coalesce(${schema.userDecisions.context}->>'subkind', '') <> 'manual'`,
        sql`not exists (select 1 from user_decisions later where later.project_id = ${schema.userDecisions.projectId} and later.id > ${schema.userDecisions.id} and later.context->>'flagId' = ${schema.userDecisions.context}->>'flagId')`,
      ),
    )
    .orderBy(desc(schema.userDecisions.id))
    .limit(max);
}

// ── export ─────────────────────────────────────────────────────────────────

export const EXPORT_MAX = 1000;

/**
 * A page of a user's decisions in export form (oldest first, so an export can resume from `nextCursor`), plus the
 * eval cases they stand for (`decisions/cases.ts`). `reelsaw decisions export` writes the items as JSON lines.
 */
export async function exportDecisions(
  db: Db,
  userId: string,
  input: { cursor?: number | undefined; limit?: number; since?: Date | undefined; kind?: DecisionKind | undefined } = {},
) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), EXPORT_MAX);
  const rows = await db
    .select()
    .from(schema.userDecisions)
    .where(
      and(
        eq(schema.userDecisions.userId, userId),
        input.cursor ? gt(schema.userDecisions.id, input.cursor) : undefined,
        input.since ? gte(schema.userDecisions.createdAt, input.since) : undefined,
        input.kind ? eq(schema.userDecisions.kind, input.kind) : undefined,
        notBeingForgotten,
      ),
    )
    .orderBy(asc(schema.userDecisions.id))
    .limit(limit + 1);
  const items: ExportedDecision[] = rows.slice(0, limit).map(({ userId: _userId, ...r }) => {
    void _userId;
    return { ...r, createdAt: r.createdAt.toISOString() };
  });
  return { items, cases: { disfluency: disfluencyCases(items) }, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

// ── backfill ───────────────────────────────────────────────────────────────

export const BACKFILL_BATCH = 50;

/**
 * Decisions that existed before the log, from the transcripts that still hold them (`reelsaw decisions backfill`):
 * accepted / rejected detector fixes, manual fixes and deleted fixes of every project, live or in Deleted, whose
 * owner has learning on, skipping fixes the log already has (decided since it started, or an earlier run), so a rerun
 * adds nothing. Clip edits cannot be recovered: their
 * before-values are gone. Rows carry `context.backfilled` and the project's last change as their time.
 */
export async function backfillDecisions(svc: Services, o: { dryRun?: boolean; budgetMs?: number } = {}) {
  const db = svc.database.db;
  let projects = 0;
  let written = 0;
  const loop = await keysetLoop<{ id: string }, string>({
    size: BACKFILL_BATCH,
    deadline: deadlineIn(o.budgetMs),
    start: null,
    fetch: (cursor, size) =>
      db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(cursor ? gt(schema.projects.id, cursor) : undefined)
        .orderBy(asc(schema.projects.id))
        .limit(size),
    cursorOf: (r) => r.id,
    handle: async (page) => {
      for (const { id } of page) {
        const n = await svc.tx(async (u) => {
          const [p] = await u.db.select().from(schema.projects).where(eq(schema.projects.id, id));
          if (!p) return 0;
          // fixes decided since the log started already have rows; a rerun finds every fix logged and adds nothing
          const logged = new Set(
            (
              await u.db
                .selectDistinct({ flagId: sql<string | null>`${schema.userDecisions.context}->>'flagId'` })
                .from(schema.userDecisions)
                .where(eq(schema.userDecisions.projectId, id))
            ).map((r) => r.flagId),
          );
          const [t] = await u.db
            .select({
              flags: schema.transcripts.flags,
              deletedFlags: schema.transcripts.deletedFlags,
              rawWords: schema.transcripts.rawWords,
              words: schema.transcripts.words,
            })
            .from(schema.transcripts)
            .where(eq(schema.transcripts.projectId, id));
          if (!t) return 0;
          const at = p.updatedAt;
          const items: Parameters<typeof fixDecisions>[3] = [];
          for (const f of t.flags) {
            if (f.subkind === "manual") items.push({ kind: "fix.manual", flag: f, before: null, after: f, createdAt: at, backfilled: true });
            else if (f.status === "accepted")
              items.push({ kind: "fix.accept", flag: f, before: { ...f, status: "pending" }, after: f, createdAt: at, backfilled: true });
            else if (f.status === "rejected")
              items.push({ kind: "fix.reject", flag: f, before: { ...f, status: "pending" }, after: f, createdAt: at, backfilled: true });
          }
          for (const d of t.deletedFlags ?? []) {
            const { deletedAt, ...f } = d;
            items.push({ kind: "fix.delete", flag: f, before: f, after: null, createdAt: new Date(deletedAt), backfilled: true });
          }
          const fresh = items.filter((it) => !logged.has(it.flag.id));
          if (!fresh.length) return 0;
          const rows = await fixDecisions(u.db, id, t.rawWords ?? t.words, fresh);
          if (o.dryRun) return (await learningOn(u.db, p.userId)) ? rows.length : 0;
          return recordDecisions(svc, u.db, p, () => rows);
        });
        if (n) {
          projects++;
          written += n;
        }
      }
    },
  });
  return { projects, decisions: written, complete: loop.complete, dryRun: !!o.dryRun };
}
