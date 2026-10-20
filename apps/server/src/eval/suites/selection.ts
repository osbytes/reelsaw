/**
 * selection: invariants of clip selection on a real stored transcript.
 *  - offline cases: transcript chunking (full coverage, bounded overlap and size, order), the
 *    "05:28 → 528" timestamp repair, snapping candidates to sentence boundaries within the
 *    configured length, the auto-mode score gate under stingy / generous / bimodal judges, and
 *    how many sliding pairwise passes it takes to place the top 3.
 *  - creator picks: does our picker find the moments the creator cut their own shorts from?
 *    (labels from apps/server/src/eval/tools/creator-spans.ts; see creatorPickCases below)
 *  - `selection-model` (needs models): one real map call per chunk sample; every returned candidate
 *    must land inside its chunk (after repair) and survive snapping. Catches prompt / parsing drift.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { defaultProjectSettings, type ClipCandidate, type TranscriptSegment, type Word } from "@reelsaw/shared";
import { sentenceEndAfter } from "../../pipeline/thought.js";
import { chunkTranscript, excludeRanges, MAP_CHUNK_CHARS, MAP_CHUNK_SECONDS, mapChunk, needsSecondLook, repairTimestamps, pairwiseRank, pairwiseCalls, scoreCandidates, type LlmOpts, type ScoreInput, type ScoreResult, type SelectContext } from "../../pipeline/select.js";
import { clipCap, scoreGate, snapCandidate, type ScoreGateOpts } from "../../pipeline/analyze.js";
import { isUnavailable, type CaseResult, type Suite, type SummaryMetric, type EvalContext } from "../framework.js";
import { evalAi } from "../asr.js";

interface TranscriptFixture {
  title: string;
  durationSec: number;
  segments: TranscriptSegment[];
  /** word-level fixtures also run the "clip ends on a complete thought" cases */
  words?: Word[];
  sceneCuts?: number[];
  cases?: Array<{ id: string; propose: [number, number]; expectEnd: number; tolerance: number; windowStart: number }>;
}

async function fixtures(ctx: EvalContext) {
  const root = ctx.fixtures("selection");
  const out: Array<{ name: string; t: TranscriptFixture }> = [];
  for (const name of (await fs.readdir(root)).sort()) {
    // creator-picks fixtures keep only windows of an episode: the whole-transcript invariants do not apply
    if (existsSync(path.join(root, name, "picks.json"))) continue;
    const f = path.join(root, name, "transcript.json");
    try {
      out.push({ name, t: JSON.parse(await fs.readFile(f, "utf8")) as TranscriptFixture });
    } catch {
      /* not a transcript fixture */
    }
  }
  return out;
}

const cand = (startSec: number, endSec: number): ClipCandidate => ({ title: "t", hook: "h", startSec, endSec, score: 50, reasoning: "", caption: "", hashtags: [] });

/**
 * The auto-mode score gate on synthetic rubric totals from judges with different calibration
 * (pointwise scores do not transfer across models). The relative rule must keep the leader and a
 * sane share under every judge; the old absolute 45 is run too, to show what it does to a stingy one.
 */
function gateCases(): CaseResult[] {
  const dists: Record<string, number[]> = {
    // the same kind of run, judged by a model that never gives more than 5/10
    stingy: [48, 40, 38, 36, 35, 33, 31, 30, 28, 26, 24, 22],
    // ... and by one that rarely gives less than 6/10
    generous: [95, 92, 90, 88, 85, 82, 80, 77, 74, 70, 66, 62],
    // strong moments plus a few the judge recognises as junk (intro, sponsor read)
    bimodal: [85, 82, 80, 78, 75, 72, 70, 22, 20, 18, 15, 12],
  };
  const rel = { rule: "relative" as const, floor: 25, k: 1 };
  const out: CaseResult[] = [];
  for (const [name, totals] of Object.entries(dists)) {
    for (const rule of ["relative", "absolute"] as const) {
      const g = scoreGate(totals, { ...rel, rule });
      const kept = g.keep.filter(Boolean).length;
      const fails: string[] = [];
      if (!g.keep[totals.indexOf(Math.max(...totals))]) fails.push("leader dropped");
      if (rule === "relative") {
        if (name === "bimodal") {
          const strong = totals.filter((t) => t >= 50).length;
          if (kept !== strong) fails.push(`kept ${kept}, expected the ${strong} strong ones`);
        } else if (kept < 0.5 * totals.length || kept === totals.length) fails.push(`kept ${kept}/${totals.length}: not a sane share`);
      }
      // the point of the change: a fixed cutoff empties a stingy judge's project (and keeps everything from a generous one)
      if (rule === "absolute" && name === "stingy" && kept >= 3) fails.push(`absolute kept ${kept}; expected it to collapse to the leader`);
      if (rule === "absolute" && name === "generous" && kept !== totals.length) fails.push(`absolute kept ${kept}; expected every clip`);
      out.push({ id: `gate/${name}/${rule}`, pass: !fails.length, metrics: { n: g.n, kept, threshold: g.threshold, median: g.median ?? -1, mad: g.mad ?? -1 }, notes: fails.join("; ") });
    }
  }
  // the relative rule keeps the same clips when a judge shifts and stretches its scale
  const base = dists.generous!;
  const a = scoreGate(base, { ...rel, floor: 0 }).keep.join();
  const b = scoreGate(base.map((t) => 0.5 * t - 10), { ...rel, floor: 0 }).keep.join();
  out.push({ id: "gate/affine-invariant", pass: a === b, metrics: { n: base.length }, notes: a === b ? "" : "different clips kept after rescaling the totals" });
  // degenerate pools: one clip, all equal
  const one = scoreGate([12], rel);
  const flat = scoreGate([50, 50, 50, 50], rel);
  out.push({ id: "gate/degenerate", pass: one.keep[0] === true && flat.keep.every(Boolean), metrics: { single: Number(one.keep[0]), flatKept: flat.keep.filter(Boolean).length } });
  return out;
}

/**
 * PRP-Sliding-K with a noise-free judge and the true top 3 entered last (worst case): one pass
 * only places the leader, three passes place the top 3. Calls are counted, memoised pairs reused.
 */
async function pairwiseCases(): Promise<CaseResult[]> {
  const items: ScoreInput[] = Array.from({ length: 10 }, (_, i) => ({ id: i, durationSec: 30, text: "" })); // id = true quality, worst first
  const sc: SelectContext = { title: "t", durationSec: 600, minSec: 20, maxSec: 60 };
  const out: CaseResult[] = [];
  for (const passes of [1, 3]) {
    let calls = 0;
    const judge = async (x: ScoreInput, y: ScoreInput) => {
      calls += 2; // each judgment is asked twice, positions swapped
      return x.id > y.id ? 1 : -1;
    };
    const order = await pairwiseRank({ model: undefined as never, telemetry: false }, items, sc, undefined, passes, judge);
    const top3 = order.slice(0, 3).join(",");
    const want = passes >= 3 ? "9,8,7" : "9";
    const pass = top3.startsWith(want) && calls <= pairwiseCalls(items.length, passes);
    out.push({ id: `pairwise/passes-${passes}`, pass, metrics: { calls, maxCalls: pairwiseCalls(items.length, passes), topPlaced: order.slice(0, 3).filter((id, i) => id === 9 - i).length }, notes: `top 3: ${top3}` });
  }
  return out;
}

// ---------- creator picks ----------

/**
 * `eval/fixtures/selection/<name>/picks.json`: the moments a creator cut their own shorts from,
 * written by apps/server/src/eval/tools/creator-spans.ts next to a windowed transcript.json.
 */
interface CreatorPicks {
  kind: "creator-picks";
  /** dev cases may be read while tuning prompts / the gate; heldout cases must not be (docs/EVALS.md) */
  split: "dev" | "heldout";
  episode: { id: string; url: string; title: string; uploadDate?: string; durationSec: number };
  windows: Array<[number, number]>;
  negative: [number, number] | null;
  /** hook = the short's own title: a human reference for a later hook-quality eval */
  picks: Array<{ shortId: string; hook: string; url: string; spans: Array<[number, number]> }>;
  note: string;
}

/** One pooled candidate, in final rank order (rubric total, then pairwise when it ran). */
interface RankedCandidate {
  startSec: number;
  endSec: number;
  title: string;
  hook: string;
  /** rubric total; the map pass's own guess when scoring failed (`scored: false`) */
  total: number;
  scored: boolean;
}

/** `candidates.json`: a recorded run of the real picker on the fixture's transcript, so the metrics run without a model. */
interface CandidatesFile {
  recordedAt: string;
  model: string;
  judge: string;
  samples: number;
  pairwise: boolean;
  settings: { minSec: number; maxSec: number };
  candidates: RankedCandidate[];
}

const iou1 = (a: [number, number], b: [number, number]) => {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  const union = Math.max(a[1], b[1]) - Math.min(a[0], b[0]);
  return union > 0 ? inter / union : 0;
};

/** A candidate "finds" a creator span at IoU ≥ this. Spans and clips differ in length (a 120 s pick vs a 60 s max clip), so it is loose. */
export const CREATOR_IOU = 0.3;

/**
 * Model-free scoring of a ranked candidate list against creator spans:
 *  - recall@N: share of creator spans matched (IoU ≥ 0.3) by one of our top N, N = spans + 2
 *  - bestRank: rank of our best-placed candidate that matches any span (-1: none does)
 *  - gate: does the relative score gate keep every scored candidate that matches a span?
 *  - negativesInTopN: our top N that start in the stretch the creator cut nothing from (a weak
 *    negative: the creator only posts a few shorts, so an unpicked moment is not necessarily a bad one)
 */
export function creatorPickMetrics(p: Pick<CreatorPicks, "picks" | "negative">, ranked: RankedCandidate[], gate: ScoreGateOpts) {
  const spans = p.picks.flatMap((k) => k.spans.map((s) => ({ shortId: k.shortId, span: s })));
  const n = spans.length + 2;
  const top = ranked.slice(0, n);
  const matches = (c: RankedCandidate, s: [number, number]) => iou1([c.startSec, c.endSec], s) >= CREATOR_IOU;
  const perSpan = spans.map(({ shortId, span }) => {
    let best = -1;
    let bestIou = 0;
    ranked.forEach((c, i) => {
      const v = iou1([c.startSec, c.endSec], span);
      if (v > bestIou) [best, bestIou] = [i, v];
    });
    return { shortId, span, recalled: top.some((c) => matches(c, span)), bestRank: best + 1, bestIou: Number(bestIou.toFixed(2)) };
  });
  const matching = ranked.map((c, i) => ({ c, i })).filter(({ c }) => spans.some(({ span }) => matches(c, span)));
  const scored = ranked.filter((c) => c.scored);
  const g = scoreGate(scored.map((c) => c.total), gate);
  const kept = new Set(scored.filter((_, i) => g.keep[i]));
  const matchingScored = matching.filter(({ c }) => c.scored);
  const recalled = perSpan.filter((s) => s.recalled).length;
  return {
    spans: spans.length,
    n,
    recalled,
    recallAtN: Number((recalled / (spans.length || 1)).toFixed(2)),
    picksFound: p.picks.filter((k) => perSpan.some((s) => s.shortId === k.shortId && s.recalled)).length,
    picks: p.picks.length,
    bestRank: matching.length ? matching[0]!.i + 1 : -1,
    negativesInTopN: p.negative ? top.filter((c) => c.startSec >= p.negative![0] && c.startSec < p.negative![1]).length : 0,
    matching: matchingScored.length,
    matchingKept: matchingScored.filter(({ c }) => kept.has(c)).length,
    gateThreshold: g.threshold,
    gateKept: kept.size,
    candidates: ranked.length,
    perSpan,
  };
}

function creatorResult(id: string, p: CreatorPicks, ranked: RankedCandidate[], gate: ScoreGateOpts, extra: Record<string, string | number> = {}): CaseResult {
  const m = creatorPickMetrics(p, ranked, gate);
  const fails: string[] = [];
  if (!m.recalled) fails.push(`none of the creator's ${m.spans} span(s) in our top ${m.n}`);
  if (m.matchingKept < m.matching) fails.push(`the gate drops ${m.matching - m.matchingKept} of ${m.matching} candidate(s) matching a creator span`);
  const fmtT = (x: number) => x.toFixed(0);
  const spanNotes = m.perSpan.map((s) => `${fmtT(s.span[0])}-${fmtT(s.span[1])}: ${s.recalled ? "found" : "missed"} (best IoU ${s.bestIou}${s.bestRank ? ` at rank ${s.bestRank}` : ""})`);
  const { perSpan: _p, ...metrics } = m;
  return { id, pass: !fails.length, metrics: { ...metrics, split: p.split, ...extra }, notes: [...fails, ...spanNotes].join("; ") };
}

async function creatorFixtures(ctx: EvalContext) {
  const root = ctx.fixtures("selection");
  const only = ctx.opt("split");
  if (only && only !== "dev" && only !== "heldout") throw new Error(`--split must be dev or heldout, got ${only}`);
  const out: Array<{ name: string; dir: string; p: CreatorPicks; t: TranscriptFixture & { windows: Array<[number, number]> }; recorded?: CandidatesFile }> = [];
  for (const name of (await fs.readdir(root)).sort()) {
    const dir = path.join(root, name);
    if (!existsSync(path.join(dir, "picks.json"))) continue;
    const p = JSON.parse(await fs.readFile(path.join(dir, "picks.json"), "utf8")) as CreatorPicks;
    if (only && p.split !== only) continue;
    const t = JSON.parse(await fs.readFile(path.join(dir, "transcript.json"), "utf8"));
    const cf = path.join(dir, "candidates.json");
    out.push({ name, dir, p, t, recorded: existsSync(cf) ? (JSON.parse(await fs.readFile(cf, "utf8")) as CandidatesFile) : undefined });
  }
  return out;
}

/** Like the pipeline: self-hosted models are slow and sequential, so they get one score sample and no pairwise. */
const selfHosted = (id: string, openaiBaseUrl?: string) => {
  const provider = id.split(":")[0];
  return provider === "compat" || provider === "ollama" || (provider === "openai" && !!openaiBaseUrl);
};

class NotRecorded extends Error {}

/**
 * The real picker on a fixture's transcript windows: chunk → map (+ a second look at sparse
 * chunks) → snap → pool (overlap, pool cap) → rubric scores → pairwise when the config enables it.
 * Mirrors analyze() steps 1-5 without the database; keep the two in step. Every model call goes
 * through ctx.cached, so a recorded run replays offline. `call: false` replays only (a cache miss
 * throws NotRecorded).
 */
async function runPicker(ctx: EvalContext, t: TranscriptFixture & { windows: Array<[number, number]> }, call: boolean): Promise<CandidatesFile> {
  const cfg = ctx.config();
  const settings = defaultProjectSettings;
  const sc: SelectContext = { title: t.title, durationSec: t.durationSec, minSec: settings.minClipSeconds, maxSec: settings.maxClipSeconds };
  const judgeId = cfg.ANALYZE_JUDGE_MODEL ?? cfg.AI_MODEL;
  const judgeSelf = selfHosted(judgeId, cfg.OPENAI_BASE_URL);
  const samples = cfg.ANALYZE_SCORE_SAMPLES || (judgeSelf ? 1 : 3);
  const pairwise = cfg.ANALYZE_PAIRWISE === "on" || (cfg.ANALYZE_PAIRWISE === "auto" && !judgeSelf);
  let o: LlmOpts | undefined;
  let judge: LlmOpts | undefined;
  const models = async () => {
    o ??= { model: await ctx.ai.languageModel(), telemetry: false };
    judge ??= cfg.ANALYZE_JUDGE_MODEL ? { model: await ctx.ai.languageModel(cfg.ANALYZE_JUDGE_MODEL), telemetry: false } : o;
    return { o, judge };
  };
  const cached = <T>(key: unknown, fn: () => Promise<T>) =>
    ctx.cached(key, async () => {
      if (!call) throw new NotRecorded("not recorded");
      return fn();
    });

  // chunk each contiguous window on its own, so no chunk spans the gap between two windows
  const blocks: TranscriptSegment[][] = [];
  for (const s of t.segments) {
    const b = blocks.at(-1);
    if (b && s.start - b.at(-1)!.end < 60) b.push(s);
    else blocks.push([s]);
  }
  const chunks = blocks.flatMap((b) => chunkTranscript(b));
  const perChunk: ClipCandidate[][] = [];
  for (const ch of chunks) {
    // same key as `selection-model`, so the two share recorded calls
    const found = await cached(["map", cfg.AI_MODEL, ch.lines, sc], async () => mapChunk((await models()).o, ch, sc));
    if (needsSecondLook(ch, found, sc.minSec)) {
      const exclude = excludeRanges(found);
      found.push(...(await cached(["map-more", cfg.AI_MODEL, ch.lines, sc, exclude], async () => mapChunk((await models()).o, ch, sc, exclude).catch(() => []))));
    }
    perChunk.push(found);
  }
  const overlap = (a: ClipCandidate, b: ClipCandidate) => {
    const inter = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
    const shortest = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
    return shortest > 0 ? inter / shortest : 0;
  };
  const snapped = perChunk
    .flat()
    .map((c) => snapCandidate(c, t.segments, [], settings, t.durationSec))
    .filter((c): c is ClipCandidate => c !== null)
    .sort((a, b) => b.score - a.score);
  const pool: ClipCandidate[] = [];
  for (const c of snapped) if (!pool.some((k) => overlap(k, c) > 0.3)) pool.push(c);
  // the cap follows the transcript the picker saw (the windows), not the whole episode
  const seen = t.windows.reduce((a, [s, e]) => a + (e - s), 0);
  const pooled = pool.slice(0, Math.min(40, Math.max(clipCap(settings, seen) * 3, 12)));
  const textFor = (c: ClipCandidate) =>
    t.segments
      .filter((s) => s.end > c.startSec + 0.1 && s.start < c.endSec - 0.1)
      .map((s) => s.text.trim())
      .join(" ")
      .slice(0, 2500);
  const inputs: ScoreInput[] = pooled.map((c, id) => ({ id, durationSec: c.endSec - c.startSec, text: textFor(c) }));
  const scoredList = await cached(["score", judgeId, inputs, sc, samples], async () => [...(await scoreCandidates((await models()).judge, inputs, sc, samples, 1)).entries()]);
  const scored = new Map<number, ScoreResult>(scoredList);
  const byTotal = (a: { total: number }, b: { total: number }) => b.total - a.total;
  const rated = pooled.map((c, id) => ({ c, id, total: scored.get(id)?.total ?? Math.round(c.score), scored: scored.has(id) }));
  let ranked = [...rated.filter((x) => x.scored).sort(byTotal), ...rated.filter((x) => !x.scored).sort(byTotal)];
  if (pairwise && ranked.length > 2) {
    // like analyze(): only the gate's keepers are compared head to head
    const gate = scoreGate(ranked.filter((x) => x.scored).map((x) => x.total), { rule: cfg.ANALYZE_SCORE_RULE, floor: cfg.ANALYZE_MIN_SCORE_FLOOR, k: cfg.ANALYZE_SCORE_MAD_K });
    const top = ranked.filter((x, i) => x.scored && gate.keep[i]).slice(0, 10);
    const order = await cached(["pairwise", judgeId, top.map((x) => inputs[x.id]), sc, cfg.ANALYZE_PAIRWISE_PASSES], async () => pairwiseRank((await models()).judge, top.map((x) => inputs[x.id]!), sc, undefined, cfg.ANALYZE_PAIRWISE_PASSES));
    const byId = new Map(top.map((x) => [x.id, x]));
    ranked = [...order.map((id) => byId.get(id)!), ...ranked.filter((x) => !byId.has(x.id))];
  }
  return {
    recordedAt: new Date().toISOString(),
    model: cfg.AI_MODEL,
    judge: judgeId,
    samples,
    pairwise,
    settings: { minSec: sc.minSec, maxSec: sc.maxSec },
    candidates: ranked.map(({ c, total, scored: s }) => ({ startSec: c.startSec, endSec: c.endSec, title: c.title, hook: c.hook, total, scored: s })),
  };
}

/**
 * Creator picks: did our picker find the moments the creator cut their own shorts from?
 *  - `creator-picks/<name>`: model-free, on the recorded `candidates.json` (the real picker's
 *    ranked pool from one run, with the model named in the file). Re-scores rank and the gate with
 *    the current code, so a change to the gate or the metric shows up without a model.
 *  - `creator-picks/<name>/live`: the real picker now (runPicker). Replays recorded calls from
 *    eval/.cache; calls the model only with `--creator-picks live` (or `save`, which also rewrites
 *    candidates.json). Without either, a cache miss marks it skipped.
 * Pass = at least one creator span in our top N and the gate keeps every candidate matching one.
 */
async function creatorPickCases(ctx: EvalContext): Promise<CaseResult[]> {
  const cfg = ctx.config();
  const gate: ScoreGateOpts = { rule: cfg.ANALYZE_SCORE_RULE, floor: cfg.ANALYZE_MIN_SCORE_FLOOR, k: cfg.ANALYZE_SCORE_MAD_K };
  const mode = ctx.opt("creator-picks");
  if (mode && mode !== "live" && mode !== "save") throw new Error(`--creator-picks must be live or save, got ${mode}`);
  const call = !!mode && !ctx.offline;
  const out: CaseResult[] = [];
  for (const { name, dir, p, t, recorded } of await creatorFixtures(ctx)) {
    const id = `creator-picks/${name}`;
    if (recorded) out.push(creatorResult(id, p, recorded.candidates, gate));
    else out.push({ id, pass: false, skipped: "no candidates.json recorded yet (run once with --creator-picks save)" });
    const t0 = Date.now();
    try {
      const live = await runPicker(ctx, t, call);
      if (mode === "save") await fs.writeFile(path.join(dir, "candidates.json"), JSON.stringify(live, null, 1) + "\n");
      out.push(creatorResult(`${id}/live`, p, live.candidates, gate, { sec: Number(((Date.now() - t0) / 1000).toFixed(1)) }));
    } catch (err) {
      if (err instanceof NotRecorded) out.push({ id: `${id}/live`, pass: false, skipped: "model calls not in eval/.cache (run with --creator-picks live)" });
      else if (isUnavailable(err)) out.push({ id: `${id}/live`, pass: false, skipped: `model unavailable: ${(err as Error).message.slice(0, 100)}` });
      else out.push({ id: `${id}/live`, pass: false, notes: (err as Error).message.slice(0, 160) });
    }
  }
  return out;
}

/** recall@N and gate-kept share over creator-picks cases, as counts so the summary prints a Wilson CI. */
function creatorSummary(results: CaseResult[], live: boolean, prefix: string): Record<string, SummaryMetric> {
  const rs = results.filter((r) => r.id.startsWith("creator-picks/") && r.id.endsWith("/live") === live);
  if (!rs.length) return {};
  const sum = (k: string) => rs.reduce((a, r) => a + Number(r.metrics?.[k] ?? 0), 0);
  const ratio = (k: number, n: number, better: "higher" | "lower" = "higher"): SummaryMetric => ({ value: Number((n ? k / n : 0).toFixed(2)), better, ratio: { k, n } });
  return {
    [`${prefix}RecallAtN`]: ratio(sum("recalled"), sum("spans")),
    [`${prefix}PicksFound`]: ratio(sum("picksFound"), sum("picks")),
    [`${prefix}GateKeepsMatches`]: ratio(sum("matchingKept"), sum("matching")),
  };
}

export const selectionSuite: Suite = {
  name: "selection",
  description: "chunking, timestamp repair and sentence snapping invariants on a real transcript; recall of creators' own short picks",
  needs: [],
  async run(ctx) {
    const out: CaseResult[] = [];
    // timestamp repair: small models write 05:28.0 as 528
    const repairCases: Array<[number, number, number, number]> = [
      [457, 528, 297, 328],
      [540, 607, 340, 367],
      [310, 350, 310, 350],
      [5.07, 5.28, 307, 328],
    ];
    const bad = repairCases.filter(([a, b, ea, eb]) => {
      const r = repairTimestamps(cand(a, b), { start: 300, end: 420 });
      return Math.abs(r.startSec - ea) > 0.01 || Math.abs(r.endSec - eb) > 0.01;
    });
    out.push({ id: "repair-mmss", pass: !bad.length, metrics: { cases: repairCases.length }, notes: bad.map((b) => `${b[0]}-${b[1]}`).join(", ") });
    out.push(...gateCases(), ...(await pairwiseCases()));

    for (const { name, t } of await fixtures(ctx)) {
      const segs = t.segments;
      const chunks = chunkTranscript(segs);
      const fails: string[] = [];
      // chunks span the whole transcript in order, without gaps, with bounded overlap and size
      const lastEnd = chunks.at(-1)?.end ?? 0;
      if (Math.abs(lastEnd - segs.at(-1)!.end) > 0.01) fails.push(`last chunk ends at ${lastEnd}, transcript at ${segs.at(-1)!.end}`);
      if (Math.abs(chunks[0]!.start - segs[0]!.start) > 0.01) fails.push("first chunk does not start at the first segment");
      for (let i = 1; i < chunks.length; i++) {
        if (chunks[i]!.start < chunks[i - 1]!.start) fails.push(`chunk ${i} starts before chunk ${i - 1}`);
        if (chunks[i]!.start > chunks[i - 1]!.end) fails.push(`gap between chunk ${i - 1} and ${i}`);
        const ov = (chunks[i - 1]!.end - chunks[i]!.start) / Math.max(1, chunks[i - 1]!.end - chunks[i - 1]!.start);
        if (ov > 0.4) fails.push(`chunk ${i} overlaps ${(ov * 100).toFixed(0)}%`);
      }
      const maxChars = Math.max(...chunks.map((c) => c.lines.join("\n").length));
      if (maxChars > MAP_CHUNK_CHARS * 1.6) fails.push(`chunk of ${maxChars} chars`);
      if (chunks.length > 1) {
        const long = chunks.filter((c, i) => i < chunks.length - 1 && c.end - c.start > MAP_CHUNK_SECONDS * 1.4);
        if (long.length) fails.push(`non-last chunk of ${(long[0]!.end - long[0]!.start).toFixed(0)} s`);
      }
      out.push({ id: `${name}/chunking`, pass: !fails.length, metrics: { chunks: chunks.length, maxChars, segments: segs.length }, notes: fails.join("; ") });

      // snapping: candidates at odd times snap to segment boundaries within the length range
      const settings = defaultProjectSettings;
      const starts = new Set(segs.map((s) => s.start));
      const ends = new Set(segs.map((s) => s.end));
      const snapFails: string[] = [];
      let tried = 0;
      // like a model: picks line timestamps, but a little off (±2 s), and a rough 35 s length
      for (let k = 0; k < 40; k++) {
        const seg = segs[Math.floor(((k + 0.5) / 40) * (segs.length - 1))]!;
        const jitter = (((k * 7919) % 400) / 100 - 2) * 0.9;
        const s0 = Math.max(0, seg.start + jitter);
        const c = snapCandidate(cand(s0, s0 + 35), segs, [], settings, t.durationSec);
        if (!c) continue;
        tried++;
        const len = c.endSec - c.startSec;
        if (len < settings.minClipSeconds - 0.01 || len > settings.maxClipSeconds + 0.7) snapFails.push(`${s0.toFixed(0)}s → length ${len.toFixed(1)}`);
        const onStart = c.startSec === 0 || [...starts].some((x) => Math.abs(x - 0.25 - c.startSec) < 0.02 || Math.abs(Math.max(0, x - 0.25) - c.startSec) < 0.02);
        const onEnd = Math.abs(c.endSec - t.durationSec) < 0.02 || [...ends].some((x) => Math.abs(x + 0.35 - c.endSec) < 0.02);
        if (!onStart || !onEnd) snapFails.push(`${s0.toFixed(1)}s → ${c.startSec}-${c.endSec} not on sentence boundaries`);
      }
      out.push({ id: `${name}/snapping`, pass: !snapFails.length && tried > 20, metrics: { candidates: tried }, notes: snapFails.slice(0, 4).join("; ") });

      // a clip ends on a complete thought: what the model proposed goes through the real snapper with words
      for (const k of t.cases ?? []) {
        const words = t.words ?? [];
        const c = snapCandidate(cand(k.propose[0], k.propose[1]), segs, t.sceneCuts ?? [], { ...settings, minClipSeconds: 20, maxClipSeconds: 60 }, t.durationSec, { words });
        const bad: string[] = [];
        if (!c) bad.push("candidate dropped");
        else {
          const lastIdx = words.map((w, i) => ((w.start + w.end) / 2 < c.endSec - 0.35 ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
          const signal = sentenceEndAfter(words, lastIdx);
          if (!signal) bad.push(`ends inside a sentence, on "${words[lastIdx]?.text}"`);
          if (Math.abs(c.endSec - k.expectEnd) > k.tolerance) bad.push(`end ${c.endSec} is ${(c.endSec - k.expectEnd).toFixed(2)} s from the user's ${k.expectEnd}`);
          if (c.startSec > k.windowStart + 0.5) bad.push(`starts at ${c.startSec}, after ${k.windowStart}`);
        }
        out.push({ id: `${name}/${k.id}`, pass: !bad.length, metrics: { start: c?.startSec ?? -1, end: c?.endSec ?? -1, expectEnd: k.expectEnd, offBy: c ? Number((c.endSec - k.expectEnd).toFixed(2)) : -1 }, notes: bad.join("; ") });
      }
    }
    out.push(...(await creatorPickCases(ctx)));
    return out;
  },
  summarize(results) {
    // passRate covers the invariants; creator picks are a measurement (a miss is a finding, not a bug)
    const inv = results.filter((r) => !r.id.startsWith("creator-picks/"));
    return {
      passRate: { value: Number((inv.filter((r) => r.pass).length / (inv.length || 1)).toFixed(2)), better: "higher" },
      ...creatorSummary(results, false, "creator"),
      ...creatorSummary(results, true, "creatorLive"),
    };
  },
};

export const selectionModelSuite: Suite = {
  name: "selection-model",
  description: "one real map call per sampled chunk: candidates inside the chunk, parseable, snappable",
  needs: ["models"],
  async run(ctx) {
    const out: CaseResult[] = [];
    const cfg = ctx.config();
    let o: LlmOpts;
    try {
      o = { model: await evalAi(ctx).languageModel(), telemetry: false };
    } catch (err) {
      return [{ id: "(model)", pass: false, skipped: (err as Error).message.slice(0, 120) }];
    }
    for (const { name, t } of await fixtures(ctx)) {
      const chunks = chunkTranscript(t.segments);
      const pick = Number(ctx.opt("selection-chunks") ?? 1);
      for (const [i, ch] of chunks.slice(0, pick).entries()) {
        const sc: SelectContext = { title: t.title, durationSec: t.durationSec, minSec: defaultProjectSettings.minClipSeconds, maxSec: defaultProjectSettings.maxClipSeconds };
        const t0 = Date.now();
        try {
          const found = await ctx.cached(["map", cfg.AI_MODEL, ch.lines, sc], () => mapChunk(o, ch, sc));
          const outside = found.filter((c) => c.startSec < ch.start - 5 || c.endSec > ch.end + 5);
          const snapped = found.map((c) => snapCandidate(c, t.segments, [], defaultProjectSettings, t.durationSec)).filter(Boolean);
          // model-free quality proxies, comparable across models: how many proposals already respect the
          // length range, how many overlap another proposal (duplicates), and whether hooks are real
          const inRange = found.filter((c) => c.endSec - c.startSec >= sc.minSec && c.endSec - c.startSec <= sc.maxSec).length;
          const overlapping = found.filter((c, k) => found.some((d, j) => j !== k && Math.min(c.endSec, d.endSec) - Math.max(c.startSec, d.startSec) > 0.5 * Math.min(c.endSec - c.startSec, d.endSec - d.startSec))).length;
          const weakHooks = found.filter((c) => c.hook.trim().length < 12 || c.hook.trim().toLowerCase() === c.title.trim().toLowerCase()).length;
          const pass = found.length > 0 && !outside.length && snapped.length >= Math.ceil(found.length / 2);
          out.push({
            id: `${name}/chunk-${i}`,
            pass,
            metrics: { candidates: found.length, outside: outside.length, snappable: snapped.length, inRange, overlapping, weakHooks, sec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
            notes: outside.map((c) => `${c.startSec}-${c.endSec}`).join(", "),
          });
        } catch (err) {
          if (isUnavailable(err)) out.push({ id: `${name}/chunk-${i}`, pass: false, skipped: `model unavailable: ${(err as Error).message.slice(0, 100)}` });
          else out.push({ id: `${name}/chunk-${i}`, pass: false, notes: (err as Error).message.slice(0, 160) });
        }
      }
    }
    return out;
  },
  summarize(results) {
    const n = (k: string) => results.reduce((a, r) => a + Number(r.metrics?.[k] ?? 0), 0);
    const candidates = n("candidates");
    const rate = (k: string) => Number((candidates ? n(k) / candidates : 0).toFixed(2));
    return {
      passRate: { value: Number((results.filter((r) => r.pass).length / (results.length || 1)).toFixed(2)), better: "higher" },
      candidatesPerChunk: { value: Number((candidates / (results.length || 1)).toFixed(1)), better: "higher" },
      inRangeRate: { value: rate("inRange"), better: "higher", tolerance: 0.1 },
      overlapRate: { value: rate("overlapping"), better: "lower", tolerance: 0.1 },
      weakHookRate: { value: rate("weakHooks"), better: "lower", tolerance: 0.1 },
    };
  },
};
