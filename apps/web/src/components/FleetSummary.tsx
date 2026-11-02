/**
 * Settings → System → Overview: the fleet at a glance. Four tiles read the same queries as the Workers and
 * Queue sections (shared cache), each with a glyph and a word, and each jumps to the section with the detail.
 * This replaces the CPU / memory / disk gauges of the process that served the page, which said nothing about
 * the workers once jobs run on other machines; each worker's own shortage is on its Workers row.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { useSystemStatus } from "../lib/account";
import { ago, elapsed } from "../lib/time";
import { Skeleton, SkeletonRegion } from "./ui";

type Tone = "ok" | "warn" | "err" | "idle";
const FG: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", err: "text-err", idle: "text-ink3" };

/** A waiting job this old with nothing running on its stage is worth a look. */
export const LONG_WAIT_MS = 10 * 60_000;

/** Pipeline queues are the ones a worker process listens on; webhooks and billing run elsewhere. */
export const isPipelineQueue = (q: string) => /^(project|refine|clip)\./.test(q);

const PAUSED_WORD: Record<string, string> = { memory: "short of memory", CPU: "CPU busy", disk: "disk nearly full" };
export const pausedWord = (p: string) => PAUSED_WORD[p] ?? p;

interface Tile {
  id: string;
  label: string;
  glyph: string;
  word: string;
  value: string;
  note: string;
  tone: Tone;
}

export function FleetSummary({ onJump }: { onJump: (id: string) => void }) {
  const trpc = useTRPC();
  const workers = useQuery({ ...trpc.admin.workers.list.queryOptions(), refetchInterval: 5000 });
  const queue = useQuery({ ...trpc.admin.queue.summary.queryOptions(), refetchInterval: 5000 });
  const [weekAgo] = useState(() => new Date(Date.now() - 7 * 86400_000).toISOString());
  const failures = useQuery({ ...trpc.admin.failures.list.queryOptions({ since: weekAgo, limit: 1 }), refetchInterval: 30_000 });
  const paused = useSystemStatus(30_000).data?.paused ?? null;

  const w = workers.data;
  const qd = queue.data;
  const f = failures.data;
  if (!w || !qd || !f) {
    return (
      <SkeletonRegion label="Loading the fleet…" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex h-[5.5rem] flex-col gap-2 rounded-[12px] border border-line p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </SkeletonRegion>
    );
  }

  const live = w.items.filter((x) => x.live);
  const takers = live.filter((x) => x.queues.length > 0);
  const apiOnly = live.filter((x) => x.role === "api").length;
  const version = w.items.find((x) => x.thisProcess)?.version;
  const behind = live.filter((x) => version && x.version !== version).length;
  const workersTile: Tile = !live.length
    ? { id: "workers", label: "Workers", glyph: "○", word: "None", value: "0 online", note: "No process has checked in", tone: "err" }
    : !takers.length
      ? { id: "workers", label: "Workers", glyph: "✕", word: "No worker", value: `${live.length} online`, note: "None takes jobs: start a worker", tone: "err" }
      : {
          id: "workers",
          label: "Workers",
          glyph: w.stale || behind ? "◐" : "●",
          word: w.stale ? `${w.stale} gone` : behind ? `${behind} on another version` : "Online",
          value: `${live.length} online`,
          note: `${takers.length} ${takers.length === 1 ? "takes" : "take"} jobs${apiOnly ? ` · ${apiOnly} API only` : ""}`,
          tone: w.stale || behind ? "warn" : "ok",
        };

  const running = qd.queues.reduce((n, r) => n + r.running, 0);
  const waiting = qd.queues.reduce((n, r) => n + r.waiting + r.retrying, 0);
  const oldest = qd.queues
    .map((r) => r.oldestWaitingAt)
    .filter((x): x is string => !!x)
    .sort()[0];
  const longWait = !!oldest && Date.now() - new Date(oldest).getTime() > LONG_WAIT_MS;
  const jobsTile: Tile = qd.error
    ? { id: "queue", label: "Jobs", glyph: "?", word: "Unknown", value: "—", note: "Queue tables are not ready", tone: "idle" }
    : paused && waiting
      ? { id: "workers", label: "Jobs", glyph: "◷", word: "Paused", value: `${waiting} waiting`, note: `Every worker is ${pausedWord(paused)}`, tone: "warn" }
      : !running && !waiting
        ? { id: "queue", label: "Jobs", glyph: "○", word: "Idle", value: "Nothing queued", note: "Workers are free", tone: "idle" }
        : {
            id: "queue",
            label: "Jobs",
            glyph: longWait ? "◷" : "◔",
            word: longWait ? "Slow" : "Working",
            value: `${running} running · ${waiting} waiting`,
            note: oldest ? `Longest wait ${elapsed(oldest)}` : "Nothing waiting",
            tone: longWait ? "warn" : "ok",
          };

  const slots = takers.reduce((a, x) => ({ busy: a.busy + x.renders.running, max: a.max + x.renders.max }), { busy: 0, max: 0 });
  const rendersTile: Tile = {
    id: "workers",
    label: "Render slots",
    glyph: slots.max && slots.busy >= slots.max ? "●" : slots.busy ? "◔" : "○",
    word: !slots.max ? "None" : slots.busy >= slots.max ? "Full" : slots.busy ? "In use" : "Free",
    value: slots.max ? `${slots.busy} of ${slots.max} busy` : "—",
    note: `Across ${takers.length} ${takers.length === 1 ? "process" : "processes"}`,
    tone: !slots.max ? "err" : slots.busy >= slots.max ? "warn" : slots.busy ? "ok" : "idle",
  };

  const latest = f.items[0];
  const failedTile: Tile = {
    id: "queue",
    label: "Failed",
    glyph: f.total ? "!" : "✓",
    word: f.total ? "Needs a look" : "None",
    value: `${f.total}${f.truncated ? "+" : ""} this week`,
    note: latest ? `Latest ${ago(latest.failedAt)} · ${latest.stage}` : "Nothing to retry",
    tone: f.total ? "warn" : "ok",
  };

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[workersTile, jobsTile, rendersTile, failedTile].map((t) => (
        <button
          key={t.label}
          type="button"
          onClick={() => onJump(t.id)}
          className="flex h-[5.5rem] min-w-0 flex-col justify-between rounded-[12px] border border-line bg-panel p-3 text-left transition hover:border-ink3 hover:bg-sunk/50"
        >
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
            <span className="truncate text-ink3">{t.label}</span>
            <span className={`shrink-0 truncate font-semibold ${FG[t.tone]}`}>
              <span className="font-mono">{t.glyph}</span> {t.word}
            </span>
          </div>
          <div className="truncate text-[15px] font-bold tabular-nums">{t.value}</div>
          <div className="truncate text-xs text-ink2" title={t.note}>
            {t.note}
          </div>
        </button>
      ))}
    </div>
  );
}
