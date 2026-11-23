/**
 * A layer's timing as a label in the active locale: "First 3 s", "Last 4 s", "Whole clip", "20–40% of the clip".
 * The web app's form of `timingText` in @reelsaw/shared, which stays English for the CLI's operator tables.
 */
import { t } from "@lingui/core/macro";
import { formatNumber, formatPercent, type LayerTiming } from "@reelsaw/shared";

const sec = (n: number) => formatNumber(n, { maximumFractionDigits: 1 });

export function timingLabel(timing: LayerTiming): string {
  switch (timing.mode) {
    case "fill":
      return t`Whole clip`;
    case "head": {
      const start = sec(timing.start);
      const end = sec(timing.end);
      return timing.start === 0 ? t`First ${end} s` : t`${start}–${end} s from the start`;
    }
    case "tail": {
      const start = sec(timing.start);
      const end = sec(timing.end);
      return timing.end === 0 ? t`Last ${start} s` : t`${start}–${end} s before the end`;
    }
    case "relative": {
      const from = formatPercent(timing.start);
      const to = formatPercent(timing.end);
      const min = timing.minSec !== undefined ? sec(timing.minSec) : undefined;
      const max = timing.maxSec !== undefined ? sec(timing.maxSec) : undefined;
      if (min && max) return t`${from}–${to} of the clip (at least ${min} s, at most ${max} s)`;
      if (min) return t`${from}–${to} of the clip (at least ${min} s)`;
      if (max) return t`${from}–${to} of the clip (at most ${max} s)`;
      return t`${from}–${to} of the clip`;
    }
  }
}
