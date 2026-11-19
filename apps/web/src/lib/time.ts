import { formatDay, formatSeconds } from "@reelsaw/shared";

/** "5 min ago" style age for lists. */
export function ago(d: string | Date) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return formatDay(d, { month: "short" });
}

/** "42 s", "4 min", "2 h 5 min": how long something has been running or waiting. */
export function elapsed(d: string | Date) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  return s < 1 ? "0 s" : formatSeconds(s);
}
