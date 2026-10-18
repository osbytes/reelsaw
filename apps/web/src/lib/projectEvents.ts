import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { isEventsReplayed, type EventsReplayed, type ProjectEvent } from "@reelsaw/shared";
import { useTRPC } from "./trpc";
import { isListKey, scopesFor, type Scope } from "./invalidation";

interface Handlers {
  /** every stored or live event except progress ticks (replayed history included) */
  onEvent?: (e: ProjectEvent, live: boolean) => void;
  /** progress ticks: live only */
  onProgress?: (e: ProjectEvent) => void;
  /** history has been replayed; `reconnect` is true for the second and later times */
  onReplayed?: (m: EventsReplayed, reconnect: boolean) => void;
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
  const ready = useRef(false);
  const replays = useRef(0);
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
    ready.current = false;
    replays.current = 0;
    pending.current = new Set();
    return () => window.clearTimeout(timer.current);
  }, [id]);

  return useSubscription(
    trpc.projects.events.subscriptionOptions(
      { id },
      {
        onData: (envelope) => {
          const d = envelope.data as ProjectEvent | EventsReplayed;
          if (isEventsReplayed(d)) {
            const reconnect = replays.current++ > 0;
            if (!ready.current) pending.current = new Set(); // the first replay is history the page already has
            ready.current = true;
            handlers.current.onReplayed?.(d, reconnect);
            if (pending.current.size && timer.current === undefined) timer.current = window.setTimeout(flush, 120);
            return;
          }
          if (d.type === "stage.progress") return handlers.current.onProgress?.(d);
          handlers.current.onEvent?.(d, ready.current);
          if (ready.current) schedule(scopesFor(d));
        },
      },
    ),
  );
}
