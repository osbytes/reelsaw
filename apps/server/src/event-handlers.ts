/**
 * Reactions to project events, run inside the unit of work that emits them (uow.ts `emit`).
 *
 * `project_events` is already the record of what happened, and pg-boss jobs live in the same
 * database: a handler that reacts by queueing a job with `u.send` / `u.enqueue` on the emitting
 * transaction is a transactional outbox without a relay. The event, the reaction and its job commit
 * together or not at all, and every place that emits the event gets the reaction, so a transition
 * cannot forget to call it.
 *
 * Handlers stay small and in the database: read with `u.db`, queue work with `u.send`. Anything slow
 * or outside Postgres (mail, webhooks, files) belongs in the job they queue, not in the handler. A
 * handler that throws rolls the emitting transition back, which is the point: the reaction is part
 * of the state change. Handlers run in registration order.
 */
import type { ProjectEventType } from "@reelsaw/shared";
import type { UnitOfWork } from "./uow.js";

export interface EmittedEvent {
  id: number;
  projectId: string;
  type: ProjectEventType;
  payload: Record<string, unknown>;
}

export type EventHandler = (u: UnitOfWork, event: EmittedEvent) => Promise<void>;

export interface EventHandlers {
  /** `name` is for the log and for telling two handlers on one event apart. */
  on(type: ProjectEventType, name: string, handler: EventHandler): void;
  of(type: ProjectEventType): ReadonlyArray<{ name: string; handler: EventHandler }>;
}

export function createEventHandlers(): EventHandlers {
  const byType = new Map<ProjectEventType, Array<{ name: string; handler: EventHandler }>>();
  return {
    on(type, name, handler) {
      const list = byType.get(type) ?? [];
      if (list.some((h) => h.name === name)) throw new Error(`event handler "${name}" is already registered for ${type}`);
      list.push({ name, handler });
      byType.set(type, list);
    },
    of: (type) => byType.get(type) ?? [],
  };
}
