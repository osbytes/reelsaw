/**
 * Settings → System → Overview: the fleet at a glance. Four tiles read the same queries as the Workers and
 * Queue sections (shared cache), each with a glyph and a word, and each jumps to the section with the detail.
 * This replaces the CPU / memory / disk gauges of the process that served the page, which said nothing about
 * the workers once jobs run on other machines; each worker's own shortage is on its Workers row.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { i18n, type MessageDescriptor } from "@lingui/core";
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

const PAUSED_WORD: Record<string, MessageDescriptor> = { memory: msg`short of memory`, CPU: msg`CPU busy`, disk: msg`disk nearly full` };
export const pausedWord = (p: string) => {
  const d = PAUSED_WORD[p];
  return d ? i18n._(d) : p;
};

interface Tile {
  id: string;
  key: string;
  label: string;
  glyph: string;
  word: string;
  value: string;
  note: string;
  tone: Tone;
}

export function FleetSummary({ onJump }: { onJump: (id: string) => void }) {
  const { t: tr } = useLingui();
  const trpc = useTRPC();
  const workers = useQuery({ ...trpc.admin.workers.list.queryOptions(), refetchInterval: 5000 });
  const queue = useQuery({ ...trpc.admin.queue.summary.queryOptions({ detail: false }), refetchInterval: 5000 });
  const [weekAgo] = useState(() => new Date(Date.now() - 7 * 86400_000).toISOString());
  const failures = useQuery({ ...trpc.admin.failures.list.queryOptions({ since: weekAgo, limit: 1 }), refetchInterval: 30_000 });
  const paused = useSystemStatus(30_000).data?.paused ?? null;

  const w = workers.data;
  const qd = queue.data;
  const f = failures.data;
  if (!w || !qd || !f) {
    return (
      <SkeletonRegion label={tr`Loading the fleet…`} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
  const liveCount = live.length;
  const takerCount = takers.length;
  const stale = w.stale;
  const workersLabel = tr`Workers`;
  const workersTile: Tile = !live.length
    ? {
        id: "workers",
        key: "workers",
        label: workersLabel,
        glyph: "○",
        word: tr`None`,
        value: tr`0 online`,
        note: tr`No process has checked in`,
        tone: "err",
      }
    : !takers.length
      ? {
          id: "workers",
          key: "workers",
          label: workersLabel,
          glyph: "✕",
          word: tr`No worker`,
          value: tr`${liveCount} online`,
          note: tr`None takes jobs: start a worker`,
          tone: "err",
        }
      : {
          id: "workers",
          key: "workers",
          label: workersLabel,
          glyph: w.stale || behind ? "◐" : "●",
          word: w.stale ? tr`${stale} gone` : behind ? tr`${behind} on another version` : tr`Online`,
          value: tr`${liveCount} online`,
          note: apiOnly
            ? plural(takerCount, { one: `# takes jobs · ${apiOnly} API only`, other: `# take jobs · ${apiOnly} API only` })
            : plural(takerCount, { one: "# takes jobs", other: "# take jobs" }),
          tone: w.stale || behind ? "warn" : "ok",
        };

  const running = qd.queues.reduce((n, r) => n + r.running, 0);
  const waiting = qd.queues.reduce((n, r) => n + r.waiting + r.retrying, 0);
  const oldest = qd.queues
    .map((r) => r.oldestWaitingAt)
    .filter((x): x is string => !!x)
    .sort()[0];
  const longWait = !!oldest && Date.now() - new Date(oldest).getTime() > LONG_WAIT_MS;
  const jobsLabel = tr`Jobs`;
  const pausedText = paused ? pausedWord(paused) : "";
  const oldestWait = oldest ? elapsed(oldest) : "";
  const jobsTile: Tile = qd.error
    ? { id: "queue", key: "jobs", label: jobsLabel, glyph: "?", word: tr`Unknown`, value: "—", note: tr`Queue tables are not ready`, tone: "idle" }
    : paused && waiting
      ? {
          id: "workers",
          key: "jobs",
          label: jobsLabel,
          glyph: "◷",
          word: tr`Paused`,
          value: tr`${waiting} waiting`,
          note: tr`Every worker is ${pausedText}`,
          tone: "warn",
        }
      : !running && !waiting
        ? { id: "queue", key: "jobs", label: jobsLabel, glyph: "○", word: tr`Idle`, value: tr`Nothing queued`, note: tr`Workers are free`, tone: "idle" }
        : {
            id: "queue",
            key: "jobs",
            label: jobsLabel,
            glyph: longWait ? "◷" : "◔",
            word: longWait ? tr`Slow` : tr`Working`,
            value: tr`${running} running · ${waiting} waiting`,
            note: oldest ? tr`Longest wait ${oldestWait}` : tr`Nothing waiting`,
            tone: longWait ? "warn" : "ok",
          };

  const slots = takers.reduce((a, x) => ({ busy: a.busy + x.renders.running, max: a.max + x.renders.max }), { busy: 0, max: 0 });
  const busy = slots.busy;
  const max = slots.max;
  const rendersTile: Tile = {
    id: "workers",
    key: "renders",
    label: tr`Render slots`,
    glyph: slots.max && slots.busy >= slots.max ? "●" : slots.busy ? "◔" : "○",
    word: !slots.max ? tr`None` : slots.busy >= slots.max ? tr`Full` : slots.busy ? tr`In use` : tr`Free`,
    value: slots.max ? tr`${busy} of ${max} busy` : "—",
    note: plural(takerCount, { one: "Across # process", other: "Across # processes" }),
    tone: !slots.max ? "err" : slots.busy >= slots.max ? "warn" : slots.busy ? "ok" : "idle",
  };

  const latest = f.items[0];
  const total = f.total;
  const latestAgo = latest ? ago(latest.failedAt) : "";
  const latestStage = latest?.stage ?? "";
  const failedTile: Tile = {
    id: "queue",
    key: "failed",
    label: tr`Failed`,
    glyph: f.total ? "!" : "✓",
    word: f.total ? tr`Needs a look` : tr`None`,
    value: f.truncated ? tr`${total}+ this week` : tr`${total} this week`,
    note: latest ? tr`Latest ${latestAgo} · ${latestStage}` : tr`Nothing to retry`,
    tone: f.total ? "warn" : "ok",
  };

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[workersTile, jobsTile, rendersTile, failedTile].map((tile) => (
        <button
          key={tile.key}
          type="button"
          onClick={() => onJump(tile.id)}
          className="flex h-[5.5rem] min-w-0 flex-col justify-between rounded-[12px] border border-line bg-panel p-3 text-start transition hover:border-ink3 hover:bg-sunk/50"
        >
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
            <span className="truncate text-ink3">{tile.label}</span>
            <span className={`shrink-0 truncate font-semibold ${FG[tile.tone]}`}>
              <span className="font-mono">{tile.glyph}</span> {tile.word}
            </span>
          </div>
          <div className="truncate text-[15px] font-bold tabular-nums">{tile.value}</div>
          <div className="truncate text-xs text-ink2" title={tile.note}>
            {tile.note}
          </div>
        </button>
      ))}
    </div>
  );
}
