/**
 * Project event handlers, run after the event commits, with the job that runs them committed
 * atomically with the event (a transactional outbox whose relay is pg-boss).
 *
 * Handlers live in a layered map, event type → handler name → handler:
 *
 *   export const readyEmailHandlers = defineEventHandlers({
 *     "project.done": {
 *       readyEmail: {
 *         key: async ({ event, db }) => ownerOf(db, event.projectId),
 *         delaySeconds: ({ settings }) => settings.get().COMPLETION_NOTIFY_MINUTES * 60,
 *         coalesce: true,
 *         oneAtATime: true,
 *         handle: ({ key, svc }) => deliverCompletionNotice(svc, key),
 *       },
 *     },
 *   });
 *
 * `event.payload` is inferred from the event's zod schema (`projectEventSchemas` in @reelsaw/shared)
 * and parsed again when the job runs. Modules combine their maps with `mergeEventHandlers`; a handler
 * name used twice on one event does not compile (and is refused at runtime too).
 *
 * Each handler has its own queue, `event.<type>.<name>`. When an event is emitted in a unit of work,
 * `key` (reads only, on the emitting transaction) picks the job's key, or null to skip; the unit of
 * work writes the job on the same connection just before COMMIT, so the event and every handler's job
 * commit together or not at all. `handle` runs in the worker after commit, with pg-boss's retries, so
 * it must be idempotent per key.
 *
 * Concurrency is opt-in, per key, enforced by the queue's pg-boss policy rather than by the handler:
 * - `coalesce`: a job already waiting for the key absorbs the new one (debounce with `delaySeconds`).
 * - `oneAtATime`: at most one job per key runs at once, across every process.
 * Both together are pg-boss's `stately` (one waiting and one running per key).
 *
 * A `key` that throws rolls the emitting transition back: the job is part of the state change, so keep
 * it to a lookup. Only `u.emit` runs handlers; events copied in by an issue-report import
 * (report/import.ts) are history, not transitions, and run nothing.
 */
import { projectEventSchemas, type ProjectEventPayload, type ProjectEventType } from "@reelsaw/shared";
import type { QueuePolicy } from "pg-boss";
import type { Db } from "./db/index.js";
import type { Services } from "./services.js";
import type { UnitOfWork } from "./uow.js";

export interface EmittedEvent<T extends ProjectEventType = ProjectEventType> {
  id: number;
  projectId: string;
  type: T;
  payload: ProjectEventPayload<T>;
}

/** Reads on the emitting transaction. No writes: the job is the only side effect. */
export type ReadDb = Pick<Db, "select">;

/** What `key` and `delaySeconds` may consult besides the database. */
export type EventHandlerDeps = Pick<Services, "email" | "settings">;

export interface EventHandler<T extends ProjectEventType> {
  /** The job's key, or null to skip this event. Default: the event id (one job per event). */
  key?: (ctx: { event: EmittedEvent<T>; db: ReadDb; deps: EventHandlerDeps }) => string | null | Promise<string | null>;
  /** Wait this long after the event before running. */
  delaySeconds?: (deps: EventHandlerDeps) => number;
  /** Opt-in: a job already waiting for the key absorbs this one. */
  coalesce?: boolean;
  /** Opt-in: at most one job per key runs at a time. */
  oneAtATime?: boolean;
  /** pg-boss retries; default 3, a minute apart with backoff. */
  retryLimit?: number;
  /** A run older than this is failed and retried; default 300. */
  expireInSeconds?: number;
  /**
   * The work, after commit. `event` is the one whose job this is (a coalesced job runs once for several).
   * `again` queues another run for the same key on a unit of work (a batch cut short).
   */
  handle: (ctx: { event: EmittedEvent<T>; key: string; svc: Services; signal: AbortSignal; again: (u: UnitOfWork, opts?: { delaySeconds?: number }) => Promise<string | null> }) => Promise<void>;
}

/** event type → handler name → handler */
export type EventHandlerMap = { readonly [T in ProjectEventType]?: Readonly<Record<string, EventHandler<T>>> };

/** Handler names `A` and `B` both register on one event, as `"event: name"`. */
type Overlap<A, B> = {
  [E in keyof A & keyof B]: E extends string ? `${E}: ${Extract<keyof A[E] & keyof B[E], string>}` : never;
}[keyof A & keyof B];
type NoOverlap<A, B> = [Overlap<A, B>] extends [never] ? unknown : { "handler names already registered": Overlap<A, B> };

type Merged<A, B> = { [E in keyof A | keyof B]: (E extends keyof A ? A[E] : unknown) & (E extends keyof B ? B[E] : unknown) };

/** Type a module's handlers; each handler's `event.payload` is inferred from its event key. */
export function defineEventHandlers<const M extends EventHandlerMap>(map: M): M {
  return map;
}

/** Combine two modules' maps. A name already registered on the same event is a type error. */
export function mergeEventHandlers<A extends EventHandlerMap, B extends EventHandlerMap>(a: A, b: B & NoOverlap<A, B>): Merged<A, B> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const map of [a, b] as Array<Record<string, Record<string, unknown> | undefined>>) {
    for (const [type, handlers] of Object.entries(map)) {
      for (const [name, handler] of Object.entries(handlers ?? {})) {
        if (out[type]?.[name]) throw new Error(`event handler "${name}" is already registered on ${type}`);
        (out[type] ??= {})[name] = handler;
      }
    }
  }
  return out as Merged<A, B>;
}

/** The pg-boss policy that gives a handler the concurrency it opted into. */
export function policyOf(h: Pick<EventHandler<ProjectEventType>, "coalesce" | "oneAtATime">): QueuePolicy {
  if (h.coalesce && h.oneAtATime) return "stately";
  if (h.coalesce) return "short";
  if (h.oneAtATime) return "singleton";
  return "standard";
}

export const eventHandlerQueue = (type: ProjectEventType, name: string) => `event.${type}.${name}`;

export interface EventHandlerQueue {
  name: string;
  type: ProjectEventType;
  handler: string;
  def: EventHandler<ProjectEventType>;
  policy: QueuePolicy;
}

/** One queue per handler, for the queue to create and the worker to serve. */
export function eventHandlerQueues(map: EventHandlerMap): EventHandlerQueue[] {
  const out: EventHandlerQueue[] = [];
  for (const [type, handlers] of Object.entries(map) as Array<[ProjectEventType, Record<string, EventHandler<ProjectEventType>> | undefined]>) {
    for (const [name, def] of Object.entries(handlers ?? {})) out.push({ name: eventHandlerQueue(type, name), type, handler: name, def, policy: policyOf(def) });
  }
  return out;
}

/** What a handler's job carries: the event that queued it and the key it runs under. */
export interface EventHandlerJobData {
  event: EmittedEvent;
  key: string;
}

/** The job's event, checked against its schema: the row was written by us, but jobs outlive deploys. */
export function parseEventHandlerJob(type: ProjectEventType, data: unknown): EventHandlerJobData {
  const d = data as Partial<EventHandlerJobData> | null;
  if (!d || typeof d.key !== "string" || !d.event || d.event.type !== type) throw new Error(`malformed ${type} handler job`);
  const payload = projectEventSchemas[type].parse(d.event.payload) as ProjectEventPayload<ProjectEventType>;
  return { key: d.key, event: { id: Number(d.event.id), projectId: String(d.event.projectId), type, payload } };
}

/**
 * The jobs every handler asks for, in emit order and then the map's order. The uow calls this once
 * the transition's own work is done and writes each job before COMMIT.
 */
export async function eventHandlerJobs(
  map: EventHandlerMap,
  events: readonly EmittedEvent[],
  db: ReadDb,
  deps: EventHandlerDeps,
): Promise<Array<{ queue: string; handler: string; data: EventHandlerJobData; startAfter?: number }>> {
  const out: Array<{ queue: string; handler: string; data: EventHandlerJobData; startAfter?: number }> = [];
  for (const event of events) {
    const forType = (map[event.type] ?? {}) as Record<string, EventHandler<ProjectEventType>>;
    for (const [name, def] of Object.entries(forType)) {
      const key = def.key ? await def.key({ event, db, deps }) : String(event.id);
      if (key === null) continue;
      const startAfter = def.delaySeconds?.(deps);
      out.push({ queue: eventHandlerQueue(event.type, name), handler: name, data: { event, key }, ...(startAfter ? { startAfter } : {}) });
    }
  }
  return out;
}
