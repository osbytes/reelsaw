/** Small background-job state (cursors, last-run facts) in instance_settings, one row per key. */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

export async function getState<T extends Record<string, unknown>>(db: Db, key: string): Promise<Partial<T>> {
  const row = await db.query.instanceSettings.findFirst({ where: eq(schema.instanceSettings.key, key) });
  return (row?.value ?? {}) as Partial<T>;
}

export async function setState(db: Db, key: string, value: Record<string, unknown>): Promise<void> {
  await db
    .insert(schema.instanceSettings)
    .values({ key, value, updatedBy: "system" })
    .onConflictDoUpdate({ target: schema.instanceSettings.key, set: { value, updatedBy: "system", updatedAt: new Date() } });
}
