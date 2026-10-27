import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { isEventsReplayed, type EventsReplayed, type ProjectEvent } from "@reelsaw/shared";
import { useTRPC } from "./trpc";
import { isListKey, scopesFor, type Scope } from "./invalidation";

/** open: events are flowing. reconnecting: the stream dropped and is retrying (backoff in lib/sse.ts). closed: refused (signed out). */
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

interface Handlers {
  /** every live event except progress ticks */
  onEvent?: (e: ProjectEvent) => void;
  /** progress ticks: live only */
  onProgress?: (e: ProjectEvent) => void;
  /**
   * The history the stream replays on each (re)connect, delivered once as a batch (progress ticks excluded), then
   * the `events.replayed` summary. `reconnect` is true for the second and later times; with `m.hasMore` a
   * reconnect has missed events the replay does not carry.
   */
  onReplayed?: (events: ProjectEvent[], m: EventsReplayed, reconnect: boolean) => void;
  /** Projects list / stats are refreshed too (the project page); the clip editor leaves them alone */
  list?: boolean;
}

/**
 * A project's event stream plus the cache refreshes it implies (lib/invalidation.ts). Refreshes are
 * batched (a render run emits hundreds of events) and skipped for the history replayed when the page
 * opens, since the page just fetched its queries; a reconnect does refresh what the missed events touched.
 */
export function useProjectEvents(id: string, h: Handlers) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const handlers = useRef(h);
  handlers.current = h;
  const replays = useRef(0);
  const replaying = useRef(true);
  const replayBuf = useRef<ProjectEvent[]>([]);
  const pending = useRef(new Set<Scope>());
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    timer.current = undefined;
    const scopes = pending.current;
    pending.current = new Set();
    if (scopes.has("project")) void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id }) });
    if (scopes.has("transcript")) void qc.invalidateQueries({ queryKey: trpc.transcripts.get.queryKey({ projectId: id }) });
    if (scopes.has("list") && handlers.current.list) void qc.invalidateQueries({ predicate: (q) => isListKey(q.queryKey) });
  }, [qc, trpc, id]);
  const schedule = useCallback(
    (scopes: Scope[]) => {
      for (const s of scopes) pending.current.add(s);
      if (pending.current.size && timer.current === undefined) timer.current = window.setTimeout(flush, 120);
    },
    [flush],
  );

  // reset before the subscription (declared below) starts for a new project
  useEffect(() => {
    replays.current = 0;
    replaying.current = true;
    replayBuf.current = [];
    pending.current = new Set();
    return () => {
      window.clearTimeout(timer.current);
      // schedule() arms a flush only while this is undefined; a cleared id left here stopped every refresh on the next project
      timer.current = undefined;
    };
  }, [id]);

  const sub = useSubscription(
    trpc.projects.events.subscriptionOptions(
      { id },
      {
        // a new connection starts with a replay; drop a batch the last one left half-delivered
        onStarted: () => {
          replaying.current = true;
          replayBuf.current = [];
        },
        onData: (envelope) => {
          const d = envelope.data as ProjectEvent | EventsReplayed;
          if (isEventsReplayed(d)) {
            const reconnect = replays.current++ > 0;
            const events = replayBuf.current;
            replayBuf.current = [];
            replaying.current = false;
            if (reconnect) {
              // what the missed events touched; the project itself whenever the stream came back
              schedule(["project", ...events.flatMap(scopesFor)]);
              if (d.hasMore) schedule(["transcript", "list"]);
            }
            handlers.current.onReplayed?.(events, d, reconnect);
            return;
          }
          if (d.type === "stage.progress") return replaying.current ? undefined : handlers.current.onProgress?.(d);
          if (replaying.current) {
            replayBuf.current.push(d);
            return;
          }
          handlers.current.onEvent?.(d);
          schedule(scopesFor(d));
        },
      },
    ),
  );
  const opened = useRef(false);
  useEffect(() => {
    opened.current = false;
  }, [id]);
  if (sub.status === "pending") opened.current = true;
  const status: StreamStatus = sub.status === "pending" ? "open" : sub.status === "error" ? "closed" : opened.current ? "reconnecting" : "connecting";
  return { status };
}
