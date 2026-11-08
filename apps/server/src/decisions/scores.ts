/**
 * User decisions as eval scores on the project's Langfuse session (LLM_TRACE=langfuse; traces use the project id as
 * their session). Clip selection and the refine prompts get a label from what the person did with their output:
 * a deleted moment is a miss, a restored one a keep, a retimed one a near-miss, a moment they added one the model did
 * not find; a fix accepted or rejected is the refine prompt's precision. Implicit rows (a clip a re-analyze replaced)
 * and backfilled ones are left out: neither is a person judging the output in front of them.
 *
 * A score carries the decision's kind, ids, the AI score it judged and the models that produced the item: never the
 * clip text, title or transcript (those stay in the decision log). Its id is the decision's, so a retry upserts.
 */
import type { DecisionKind } from "@reelsaw/shared";

export interface DecisionScore {
  id: string;
  name: string;
  value: number;
  metadata: Record<string, string | number | boolean | string[] | null>;
}

export interface ScoredDecision {
  id: number;
  kind: DecisionKind;
  explicit: boolean;
  clipId: string | null;
  context: Record<string, unknown>;
  before: Record<string, unknown> | null;
  models: Record<string, string>;
  backfilled: boolean;
}

/** name and value per kind: 1 is the model's output standing, 0 is the person overruling it */
const SCORE: Partial<Record<DecisionKind, { name: string; value: number }>> = {
  "clip.delete": { name: "clip.kept", value: 0 },
  "clip.restore": { name: "clip.kept", value: 1 },
  "clip.create": { name: "clip.found", value: 0 },
  "fix.accept": { name: "fix.accepted", value: 1 },
  "fix.reject": { name: "fix.accepted", value: 0 },
  "fix.manual": { name: "fix.found", value: 0 },
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The scores one decision gives, or none (implicit, backfilled, or a kind that judges no model output). */
export function decisionScores(d: ScoredDecision): DecisionScore[] {
  if (!d.explicit || d.backfilled) return [];
  const origin = typeof d.context.origin === "string" ? d.context.origin : null;
  const base = {
    kind: d.kind,
    clipId: d.clipId,
    origin,
    ...(typeof d.before?.score === "number" ? { aiScore: d.before.score } : {}),
    ...(typeof d.context.flagKind === "string" ? { flagKind: d.context.flagKind } : {}),
    ...(typeof d.context.subkind === "string" ? { subkind: d.context.subkind } : {}),
    models: Object.entries(d.models).map(([k, v]) => `${k}=${v}`),
  };
  if (d.kind === "clip.edit") {
    // a person's own clip is not the model's output; edits to an AI clip say which part missed
    if (origin === "manual") return [];
    const fields = strings(d.context.fields);
    const out: DecisionScore[] = [{ id: `decision-${d.id}`, name: "clip.untouched", value: 0, metadata: { ...base, fields } }];
    if (fields.includes("bounds")) out.push({ id: `decision-${d.id}-bounds`, name: "clip.bounds_kept", value: 0, metadata: base });
    if (fields.some((f) => f === "title" || f === "hook" || f === "caption" || f === "hashtags"))
      out.push({ id: `decision-${d.id}-copy`, name: "clip.copy_kept", value: 0, metadata: { ...base, fields } });
    return out;
  }
  const s = SCORE[d.kind];
  if (!s) return [];
  // accepting or rejecting a fix the person typed judges nothing the model proposed
  if ((d.kind === "fix.accept" || d.kind === "fix.reject") && d.context.subkind === "manual") return [];
  // deleting or restoring a clip the person made is about their clip, not the model's pick
  if ((d.kind === "clip.delete" || d.kind === "clip.restore") && origin === "manual") return [];
  return [{ id: `decision-${d.id}`, name: s.name, value: s.value, metadata: base }];
}
