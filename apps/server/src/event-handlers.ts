/**
 * Event handlers: the work that follows an event, run after the event commits, with the job that runs
 * it committed atomically with the event (a transactional outbox whose relay is pg-boss).
 *
 * Every event goes through one emit, `u.emit(type, payload)`, into one table, `events` (event-types.ts
 * has every type's schema). Every handler is listed in one map, `eventHandlerMap`
 * (event-handler-map.ts), event type → handler name → handler, so all events and what follows them are
 * visible in one place; the enterprise edition adds `eeEventHandlerMap` (ee/event-handlers.ts). The
 * handlers themselves live with their modules:
 *
 *   // notify/completion.ts
 *   export const readyEmail: EventHandler<"project.done"> = {
 *     key: async ({ event, db }) => ownerOf(db, event.payload.projectId),
 *     delaySeconds: ({ settings }) => settings.get().EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES * 60,
 *     coalesce: true,
 *     oneAtATime: true,
 *     handle: ({ key, svc }) => deliverCompletionNotice(svc, key),
 *   };
 *   // event-handler-map.ts
 *   export const eventHandlerMap = defineEventHandlers({ "project.done": { readyEmail }, "webhook.disabled": { webhookDisabledEmail } });
 *
 * `event.payload` is inferred from the event's zod schema and parsed again when the job runs; it names
 * what the event is about (`projectId` on a project event, `userId` on an account event). A name
 * listed twice on one event is a duplicate key in the one object literal, which does not compile. A
 * handler's settings follow `EVENT_<EVENT>_<HANDLER>_<NAME>` (`eventHandlerSetting`), e.g.
 * EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES.
 *
 * Each handler has its own queue, `event.<type>.<name>`. When an event is emitted in a unit of work,
 * `key` (reads only, on the emitting transaction) picks the job's key, or null to skip; the unit of
 * work writes the job on the same connection just before COMMIT, so the event and every handler's job
 * commit together or not at all. `handle` runs in the worker after commit, with pg-boss's retries, so
 * it must be idempotent per key. A key handed to a provider that dedups (Resend, Stripe) names the thing
 * the side effect is about (this account's approval, this subscription's cancel), never the event row
 * or the job: two events about the same thing must collapse to one effect.
 *
 * Concurrency is opt-in, per key, enforced by the queue's pg-boss policy rather than by the handler:
 * - `coalesce`: a job already waiting for the key absorbs the new one (debounce with `delaySeconds`).
 * - `oneAtATime`: at most one job per key runs at once, across every process.
 * Both together are pg-boss's `stately` (one waiting and one running per key).
 *
 * A `key` that throws rolls the emitting transition back: the job is part of the state change, so keep
 * it to a lookup. Only `u.emit` runs handlers; a row written any other way (`eventRow` outside a unit
 * of work, an issue-report import copying history in report/import.ts) runs nothing.
 */
import { z } from "zod";
import { EVENT_TYPES, eventSchemas, type EventPayload, type EventType } from "./event-types.js";
import type { QueuePolicy } from "pg-boss";
import type { Db } from "./db/index.js";
import type { Services } from "./services.js";

/** An event as its handlers see it; with no `T`, any event. */
export interface EmittedEvent<T extends EventType = EventType> {
  id: number;
  type: T;
  /** who did it, when a person did; null = the system */
  actorId: string | null;
  payload: EventPayload<T>;
}

/** Reads on the emitting transaction. No writes: the job is the only side effect. */
export type ReadDb = Pick<Db, "select">;

/** What `key` and `delaySeconds` may consult besides the database. */
export type EventHandlerDeps = Pick<Services, "email" | "settings">;

export interface EventHandler<T extends EventType> {
  /** The job's key, or null to skip this event. Default: the event id (one job per event). */
  key?: (ctx: { event: EmittedEvent<T>; db: ReadDb; deps: EventHandlerDeps }) => string | null | Promise<string | null>;
  /** Wait this long after the event before running. */
  delaySeconds?: (deps: EventHandlerDeps) => number;
  /** Opt-in: a job already waiting for the key absorbs this one. */
  coalesce?: boolean;
  /** Opt-in: at most one job per key runs at a time. */
  oneAtATime?: boolean;
  /** Queue and worker settings; anything left out comes from EVENT_HANDLER_DEFAULTS. */
  queue?: Partial<EventHandlerQueueOptions>;
  /** The work, after commit. `event` is the one whose job this is (a coalesced job runs once for several). */
  handle: (ctx: { event: EmittedEvent<T>; key: string; svc: Services; signal: AbortSignal }) => Promise<void>;
}

/** event type → handler name → handler */
export type EventHandlerMap = { readonly [T in EventType]?: Readonly<Record<string, EventHandler<T>>> };

/** Type the handler map; each handler's `event.payload` is inferred from its event key. */
export function defineEventHandlers<const M extends EventHandlerMap>(map: M): M {
  return map;
}

/** The pg-boss policy that gives a handler the concurrency it opted into. */
export function policyOf(h: Pick<EventHandler<EventType>, "coalesce" | "oneAtATime">): QueuePolicy {
  if (h.coalesce && h.oneAtATime) return "stately";
  if (h.coalesce) return "short";
  if (h.oneAtATime) return "singleton";
  return "standard";
}

export interface EventHandlerQueueOptions {
  /** pg-boss retries after the first attempt */
  retryLimit: number;
  /** seconds before the first retry (doubling with backoff) */
  retryDelaySeconds: number;
  retryBackoff: boolean;
  /** a run older than this is failed and retried; keep it above the slowest run for oneAtATime */
  expireInSeconds: number;
  /** finished jobs are kept this long for `reelsaw status` and debugging */
  deleteAfterSeconds: number;
  /** how often an idle worker looks for a job */
  pollingIntervalSeconds: number;
  /** jobs one process runs at once (oneAtATime still holds one per key across processes) */
  localConcurrency: number;
}

export const EVENT_HANDLER_DEFAULTS: EventHandlerQueueOptions = {
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  expireInSeconds: 300,
  deleteAfterSeconds: 7 * 24 * 3600,
  pollingIntervalSeconds: 2,
  localConcurrency: 2,
};

export const eventHandlerQueue = (type: EventType, name: string) => `event.${type}.${name}`;

/** `EVENT_<EVENT>_<HANDLER>_<NAME>`: project.done + readyEmail + DELAY_MINUTES → EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES */
export function eventHandlerSetting(type: EventType, handler: string, name: string): string {
  const part = (x: string) =>
    x
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toUpperCase();
  return `EVENT_${part(type)}_${part(handler)}_${part(name)}`;
}

export interface EventHandlerQueue {
  name: string;
  type: EventType;
  handler: string;
  def: EventHandler<EventType>;
  policy: QueuePolicy;
  options: EventHandlerQueueOptions;
}

/**
 * One queue per handler, for the queue to create and the worker to serve. More than one map: the
 * enterprise edition's (ee/event-handlers.ts) after the open one, when REELSAW_EE is on. A handler name
 * on one event in two maps is refused at boot (both would serve one queue).
 */
export function eventHandlerQueues(...maps: readonly EventHandlerMap[]): EventHandlerQueue[] {
  const out: EventHandlerQueue[] = [];
  for (const map of maps) {
    // the cast widens each handler to every event type; defineEventHandlers keyed it by its own event, and the
    // worker only hands it jobs from that event's queue (parseEventHandlerJob checks the type)
    for (const [type, handlers] of Object.entries(map) as Array<[EventType, Record<string, EventHandler<EventType>> | undefined]>) {
      for (const [name, def] of Object.entries(handlers ?? {})) {
        const queue = eventHandlerQueue(type, name);
        if (out.some((q) => q.name === queue)) throw new Error(`event handler ${name} on ${type} is defined twice`);
        out.push({ name: queue, type, handler: name, def, policy: policyOf(def), options: { ...EVENT_HANDLER_DEFAULTS, ...def.queue } });
      }
    }
  }
  return out;
}

/** What a handler's job carries: the event that queued it and the key it runs under. */
export interface EventHandlerJobData {
  event: EmittedEvent;
  key: string;
}

const jobDataSchema = z.object({
  key: z.string(),
  event: z.object({ id: z.coerce.number(), type: z.enum(EVENT_TYPES), actorId: z.string().nullable().default(null), payload: z.unknown() }),
});

/** The job's event, checked against its schema: the row was written by us, but jobs outlive deploys. */
export function parseEventHandlerJob(type: EventType, data: unknown): EventHandlerJobData {
  const d = jobDataSchema.parse(data);
  if (d.event.type !== type) throw new Error(`a ${d.event.type} job on the ${type} handler queue`);
  return { key: d.key, event: { id: d.event.id, type, actorId: d.event.actorId, payload: eventSchemas[type].parse(d.event.payload) } };
}

/**
 * The jobs every handler asks for, in emit order and then the map's order. The uow calls this once
 * the transition's own work is done and writes each job before COMMIT.
 */
export async function eventHandlerJobs(
  maps: readonly EventHandlerMap[],
  events: readonly EmittedEvent[],
  db: ReadDb,
  deps: EventHandlerDeps,
): Promise<Array<{ queue: string; handler: string; data: EventHandlerJobData; startAfter?: number }>> {
  const out: Array<{ queue: string; handler: string; data: EventHandlerJobData; startAfter?: number }> = [];
  for (const event of events) {
    for (const map of maps) {
      // same widening as eventHandlerQueues: the handlers under event.type are only given events of that type
      const forType = (map[event.type] ?? {}) as Record<string, EventHandler<EventType>>;
      for (const [name, def] of Object.entries(forType)) {
        const key = def.key ? await def.key({ event, db, deps }) : String(event.id);
        if (key === null) continue;
        const startAfter = def.delaySeconds?.(deps);
        out.push({ queue: eventHandlerQueue(event.type, name), handler: name, data: { event, key }, ...(startAfter ? { startAfter } : {}) });
      }
    }
  }
  return out;
}
