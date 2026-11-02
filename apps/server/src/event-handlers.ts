/**
 * Event handlers: the work that follows an event, run after the event commits, with the job that runs
 * it committed atomically with the event (a transactional outbox whose relay is pg-boss).
 *
 * Two kinds of event have handlers: project events (`u.emit`, `project_events`, schemas in
 * @reelsaw/shared) and events (`u.emitEvent`, the shared `events` table, schemas in event-types.ts).
 * Every handler of either is listed in one map, `eventHandlerMap` (event-handler-map.ts), event type →
 * handler name → handler, so all events and what follows them are visible in one place. The handlers
 * themselves live with their modules:
 *
 *   // notify/completion.ts
 *   export const readyEmail: EventHandler<"project.done"> = {
 *     key: async ({ event, db }) => ownerOf(db, event.projectId),
 *     delaySeconds: ({ settings }) => settings.get().EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES * 60,
 *     coalesce: true,
 *     oneAtATime: true,
 *     handle: ({ key, svc }) => deliverCompletionNotice(svc, key),
 *   };
 *   // event-handler-map.ts
 *   export const eventHandlerMap = defineEventHandlers({ "project.done": { readyEmail }, "webhook.disabled": { ownerEmail } });
 *
 * `event.payload` is inferred from the event's zod schema and parsed again when the job runs; a
 * project event carries `projectId`, an event `userId` (the account it concerns). A name listed twice on one event is a
 * duplicate key in the one object literal, which does not compile. A handler's settings follow
 * `EVENT_<EVENT>_<HANDLER>_<NAME>` (`eventHandlerSetting`), e.g. EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES.
 *
 * Each handler has its own queue, `event.<type>.<name>`. When an event is emitted in a unit of work,
 * `key` (reads only, on the emitting transaction) picks the job's key, or null to skip; the unit of
 * work writes the job on the same connection just before COMMIT, so the event and every handler's job
 * commit together or not at all. `handle` runs in the worker after commit, with pg-boss's retries, so
 * it must be idempotent per key (`idempotencyKey` is there for a provider that dedups, such as Resend).
 *
 * Concurrency is opt-in, per key, enforced by the queue's pg-boss policy rather than by the handler:
 * - `coalesce`: a job already waiting for the key absorbs the new one (debounce with `delaySeconds`).
 * - `oneAtATime`: at most one job per key runs at once, across every process.
 * Both together are pg-boss's `stately` (one waiting and one running per key).
 *
 * A `key` that throws rolls the emitting transition back: the job is part of the state change, so keep
 * it to a lookup. Only `u.emit` and `u.emitEvent` run handlers; a row inserted any other way (an
 * issue-report import copying history, report/import.ts) runs nothing.
 */
import { PROJECT_EVENT_TYPES, projectEventSchemas, type ProjectEventPayload, type ProjectEventType } from "@reelsaw/shared";
import { z } from "zod";
import { EVENT_TYPES, eventSchemas, type EventPayload, type EventType } from "./event-types.js";
import type { QueuePolicy } from "pg-boss";
import type { Db } from "./db/index.js";
import type { Services } from "./services.js";
import type { UnitOfWork } from "./uow.js";

export type AnyEventType = ProjectEventType | EventType;

export function isProjectEventType(t: string): t is ProjectEventType {
  return PROJECT_EVENT_TYPES.some((x) => x === t);
}

/** A project event as its handlers see it: about one project. */
export interface ProjectEmitted<T extends ProjectEventType = ProjectEventType> {
  id: number;
  projectId: string;
  type: T;
  payload: ProjectEventPayload<T>;
}

/** An event from the `events` table as its handlers see it: about one account. */
export interface EventEmitted<T extends EventType = EventType> {
  id: number;
  userId: string;
  type: T;
  payload: EventPayload<T>;
}

/** The event a handler of `T` gets; with no `T`, any event. */
export type EmittedEvent<T extends AnyEventType = AnyEventType> = [T] extends [ProjectEventType]
  ? ProjectEmitted<T>
  : [T] extends [EventType]
    ? EventEmitted<T>
    : ProjectEmitted | EventEmitted;

/** Reads on the emitting transaction. No writes: the job is the only side effect. */
export type ReadDb = Pick<Db, "select">;

/** What `key` and `delaySeconds` may consult besides the database. */
export type EventHandlerDeps = Pick<Services, "email" | "settings">;

export interface EventHandler<T extends AnyEventType> {
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
  /**
   * The work, after commit. `event` is the one whose job this is (a coalesced job runs once for several).
   * `again` queues another run for the same key (a batch cut short) on a unit of work, so it commits
   * with whatever the handler records about this run.
   */
  handle: (ctx: {
    event: EmittedEvent<T>;
    key: string;
    svc: Services;
    signal: AbortSignal;
    /** `event.<type>.<name>:<event id>`: the same on every retry of this job, for a provider that dedups */
    idempotencyKey: string;
    again: (u: UnitOfWork, opts?: { delaySeconds?: number }) => Promise<string | null>;
  }) => Promise<void>;
}

/** event type → handler name → handler */
export type EventHandlerMap = { readonly [T in AnyEventType]?: Readonly<Record<string, EventHandler<T>>> };

/** Type the handler map; each handler's `event.payload` is inferred from its event key. */
export function defineEventHandlers<const M extends EventHandlerMap>(map: M): M {
  return map;
}

/** The pg-boss policy that gives a handler the concurrency it opted into. */
export function policyOf(h: Pick<EventHandler<AnyEventType>, "coalesce" | "oneAtATime">): QueuePolicy {
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

export const eventHandlerQueue = (type: AnyEventType, name: string) => `event.${type}.${name}`;

/** `EVENT_<EVENT>_<HANDLER>_<NAME>`: project.done + readyEmail + DELAY_MINUTES → EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES */
export function eventHandlerSetting(type: AnyEventType, handler: string, name: string): string {
  const part = (x: string) =>
    x
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toUpperCase();
  return `EVENT_${part(type)}_${part(handler)}_${part(name)}`;
}

export interface EventHandlerQueue {
  name: string;
  type: AnyEventType;
  handler: string;
  def: EventHandler<AnyEventType>;
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
    for (const [type, handlers] of Object.entries(map) as Array<[AnyEventType, Record<string, EventHandler<AnyEventType>> | undefined]>) {
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
  event: z.object({
    id: z.coerce.number(),
    type: z.enum([...PROJECT_EVENT_TYPES, ...EVENT_TYPES]),
    projectId: z.string().optional(),
    userId: z.string().optional(),
    payload: z.unknown(),
  }),
});

/** The job's event, checked against its schema: the row was written by us, but jobs outlive deploys. */
export function parseEventHandlerJob(type: AnyEventType, data: unknown): EventHandlerJobData {
  const d = jobDataSchema.parse(data);
  if (d.event.type !== type) throw new Error(`a ${d.event.type} job on the ${type} handler queue`);
  const { id, projectId, userId, payload } = d.event;
  if (isProjectEventType(type)) {
    if (projectId === undefined) throw new Error(`a ${type} job without its project`);
    return { key: d.key, event: { id, projectId, type, payload: projectEventSchemas[type].parse(payload) } };
  }
  if (userId === undefined) throw new Error(`a ${type} job without its account`);
  return { key: d.key, event: { id, userId, type, payload: eventSchemas[type].parse(payload) } };
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
      const forType = (map[event.type] ?? {}) as Record<string, EventHandler<AnyEventType>>;
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
