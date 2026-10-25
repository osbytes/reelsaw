/**
 * Project event handlers whose jobs commit atomically with the event (a transactional outbox).
 *
 * Handlers live in a layered map, event type → handler name → handler:
 *
 *   export const readyEmailHandlers = defineEventHandlers({
 *     "project.done": { readyEmail: ({ event, db, deps }) => ({ queue, data, singletonKey }) },
 *   });
 *
 * `event.payload` is inferred from the event's zod schema (`projectEventSchemas` in @reelsaw/shared).
 * Modules combine their maps with `mergeEventHandlers`; a handler name used twice on one event does
 * not compile (and is refused at runtime too).
 *
 * A handler never does its work in the emitting transaction. It only *declares* a job: it may read
 * (on the emitting transaction, so it sees the transition's own writes) and returns the job to queue,
 * or null. The unit of work (uow.ts) runs the handlers once the transition's own work is done and
 * writes their jobs on the same connection just before COMMIT, so the event row and every handler's
 * job commit together or not at all; pg-boss is the relay. The work itself runs in the job's worker,
 * after commit, with pg-boss's retries, so it must be idempotent per event.
 *
 * What a handler cannot do, by construction: write (it gets reads only), call out (it returns data;
 * the uow does the one write), or be skipped (every `u.emit` of the type runs it). A handler that
 * throws rolls the emitting transition back: the handler's job is part of the state change, so keep it to
 * a lookup or two. Only `u.emit` runs handlers; events copied in by an issue-report import
 * (report/import.ts) are history, not transitions, and run nothing.
 */
import type { ProjectEventPayload, ProjectEventType } from "@reelsaw/shared";
import type { Db } from "./db/index.js";
import type { Services } from "./services.js";

export interface EmittedEvent<T extends ProjectEventType = ProjectEventType> {
  id: number;
  projectId: string;
  type: T;
  payload: ProjectEventPayload<T>;
}

/** The job a handler asks for; written with the event's transaction. */
export interface EventHandlerJob {
  queue: string;
  data: object;
  singletonKey?: string;
  /** seconds */
  startAfter?: number;
}

/** Reads on the emitting transaction. No writes: the job is the only side effect. */
export type ReadDb = Pick<Db, "select">;

/** What handlers may consult besides the database: settings and whether mail is on. */
export type EventHandlerDeps = Pick<Services, "email" | "settings">;

export interface EventContext<T extends ProjectEventType> {
  event: EmittedEvent<T>;
  db: ReadDb;
  deps: EventHandlerDeps;
}

export type EventHandler<T extends ProjectEventType> = (ctx: EventContext<T>) => Promise<EventHandlerJob | null> | EventHandlerJob | null;

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

/**
 * The jobs every handler asks for, in emit order and then the map's order. The uow calls this once
 * the transition's own work is done and writes each job before COMMIT.
 */
export async function runEventHandlers(
  handlers: EventHandlerMap,
  events: readonly EmittedEvent[],
  db: ReadDb,
  deps: EventHandlerDeps,
): Promise<Array<{ handler: string; event: EmittedEvent; job: EventHandlerJob }>> {
  const out: Array<{ handler: string; event: EmittedEvent; job: EventHandlerJob }> = [];
  for (const event of events) {
    const forType = (handlers[event.type] ?? {}) as Record<string, EventHandler<ProjectEventType>>;
    for (const [name, handler] of Object.entries(forType)) {
      const job = await handler({ event, db, deps });
      if (job) out.push({ handler: name, event, job });
    }
  }
  return out;
}
