import { formatDay, formatNumber, formatSeconds } from "@reelsaw/shared";
import { t } from "@lingui/core/macro";

/** "5 min ago" style age for lists. */
export function ago(d: string | Date) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return t`just now`;
  if (s < 3600) {
    const n = formatNumber(Math.floor(s / 60));
    return t`${n} min ago`;
  }
  if (s < 86400) {
    const n = formatNumber(Math.floor(s / 3600));
    return t`${n} h ago`;
  }
  if (s < 86400 * 7) {
    const n = formatNumber(Math.floor(s / 86400));
    return t`${n} d ago`;
  }
  return formatDay(d, { month: "short" });
}

/** "42 s", "4 min", "2 h 5 min": how long something has been running or waiting. */
export function elapsed(d: string | Date) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  return s < 1 ? "0 s" : formatSeconds(s);
}
