/** What a stage made of saved parts reports: parts done of total and the seconds left (server: projects.stage_detail). */
export interface StageDetail {
  done: number;
  total: number;
  etaSec: number | null;
  unitMs: number | null;
}

/** "about 1.5 h left", "about 12 min left", "less than a minute left" */
export function timeLeft(sec: number): string {
  if (sec < 60) return "less than a minute left";
  const min = sec / 60;
  if (min < 90) return `about ${Math.round(min)} min left`;
  const h = min / 60;
  return `about ${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} h left`;
}

/** "13 of 43 parts, about 1 h left" */
export function describeStageDetail(d: StageDetail): string {
  return `${d.done} of ${d.total} parts${d.etaSec !== null && d.done < d.total ? `, ${timeLeft(d.etaSec)}` : ""}`;
}
