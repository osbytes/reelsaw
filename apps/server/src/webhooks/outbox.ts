/**
 * The webhook outbox (docs/specs/webhooks.md): one delivery row per matching endpoint, written by `u.emit` inside the
 * unit of work that emitted the event, with its `webhooks.deliver` job on the same connection. A rollback leaves
 * neither; a commit always has both. An account with no endpoints pays one indexed read and gets no job.
 */
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "../db/schema.js";
import { WEBHOOK_QUEUE, type Queue } from "../queue/boss.js";

export const isWebhookEvent = (type: string): type is WebhookEventType => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);

/** The unit of work's own connection, inside its BEGIN: never a pool, or rows and jobs would commit apart. */
export type TxConnection = { executeSql: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * Only `u.emit` calls this (uow.ts), with its transaction's connection: the insert and each pg-boss job (`db`, so
 * pg-boss writes the job row on that same connection) commit or roll back with the event.
 */
export async function writeDeliveries(
  tx: TxConnection,
  queue: Pick<Queue, "send">,
  eventId: number,
  projectId: string,
  type: WebhookEventType,
): Promise<number> {
  const { rows } = await tx.executeSql(
    `insert into webhook_deliveries (endpoint_id, user_id, event_id, project_id, type, status, next_attempt_at, created_at)
     select e.id, e.user_id, $1, $2, $3, 'pending', now(), now()
     from webhook_endpoints e join projects p on p.user_id = e.user_id
     where p.id = $2 and e.enabled and $3 = any(e.events)
     returning id`,
    [eventId, projectId, type],
  );
  for (const r of rows) {
    const id = String((r as { id: string | number }).id);
    await queue.send(WEBHOOK_QUEUE, { deliveryId: Number(id) }, { db: tx, singletonKey: `delivery:${id}` });
  }
  return rows.length;
}
