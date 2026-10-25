/**
 * Reactions to project events that commit atomically with the event (a transactional outbox).
 *
 * A subscription never does its work in the emitting transaction. It only *declares* a job: `react`
 * looks at the event (and may read, on the emitting transaction, so it sees the transition's own
 * writes) and returns the job to queue, or null. The unit of work (uow.ts) writes that job on the
 * same connection just before COMMIT, so the event row and every reaction's job commit together or
 * not at all, and pg-boss is the relay that delivers them. The work itself runs in the job's worker,
 * after commit, with pg-boss's retries, so it must be idempotent per event.
 *
 * What a subscription cannot do, by construction: write (it gets reads only), send mail or call out
 * (it returns data; the uow does the one write), or forget to run (every `u.emit` of the type fires
 * it). A `react` that throws rolls the emitting transition back: the reaction is part of the state
 * change, so keep it to a lookup or two. Only `u.emit` fires subscriptions; events copied in by an
 * issue-report import (report/import.ts) are history, not transitions, and fire nothing.
 */
import type { ProjectEventType } from "@reelsaw/shared";
import type { Db } from "./db/index.js";

export interface EmittedEvent {
  id: number;
  projectId: string;
  type: ProjectEventType;
  payload: Record<string, unknown>;
}

/** The job a subscription asks for; written with the event's transaction. */
export interface EventReaction {
  queue: string;
  data: object;
  singletonKey?: string;
  /** seconds */
  startAfter?: number;
}

/** Reads on the emitting transaction. No writes: the job is the only side effect. */
export type ReadDb = Pick<Db, "select">;

export interface EventSubscription {
  /** Unique; names the reaction in logs. */
  name: string;
  on: ProjectEventType;
  react(event: EmittedEvent, db: ReadDb): Promise<EventReaction | null> | EventReaction | null;
}

export interface EventSubscriptions {
  add(subscription: EventSubscription): void;
  of(type: ProjectEventType): readonly EventSubscription[];
}

export function createEventSubscriptions(): EventSubscriptions {
  const byType = new Map<ProjectEventType, EventSubscription[]>();
  const names = new Set<string>();
  return {
    add(s) {
      if (names.has(s.name)) throw new Error(`event subscription "${s.name}" is already registered`);
      names.add(s.name);
      byType.set(s.on, [...(byType.get(s.on) ?? []), s]);
    },
    of: (type) => byType.get(type) ?? [],
  };
}

/**
 * The jobs every subscription asks for, in emit then registration order. The uow calls this once the
 * transition's own work is done and writes each job before COMMIT.
 */
export async function reactionsFor(subs: EventSubscriptions, events: readonly EmittedEvent[], db: ReadDb): Promise<Array<{ subscription: string; event: EmittedEvent; job: EventReaction }>> {
  const out: Array<{ subscription: string; event: EmittedEvent; job: EventReaction }> = [];
  for (const event of events) {
    for (const s of subs.of(event.type)) {
      const job = await s.react(event, db);
      if (job) out.push({ subscription: s.name, event, job });
    }
  }
  return out;
}
