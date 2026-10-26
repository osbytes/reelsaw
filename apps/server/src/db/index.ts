import { existsSync } from "node:fs";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";
import type { Logger } from "../log.js";

export type Db = NodePgDatabase<typeof schema>;
export { schema };
export type { Project, Clip, Transcript } from "./schema.js";

export interface Database {
  pool: pg.Pool;
  db: Db;
  /** Round-trip query; throws with a readable message when the server is unreachable. */
  check(): Promise<void>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/** pg_advisory_lock key for migrations (any constant no other lock uses). */
const MIGRATE_LOCK = 727_011;

export function createDatabase(connectionString: string, log: Logger): Database {
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on("error", (err) => log.error({ err }, "pg pool error"));
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    async check() {
      try {
        await pool.query("select 1");
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { errors?: Error[] };
        const detail = e.errors?.map((x) => x.message).join("; ") || e.message;
        throw new Error(`cannot connect to Postgres at ${safeUrl(connectionString)}: ${detail}`);
      }
    },
    async migrate() {
      // next to the package: src/db/index.ts (dev), dist/db/index.js (tsc) or dist/main.js (bundle)
      const here = path.dirname(fileURLToPath(import.meta.url));
      const folder = ["../drizzle", "../../drizzle"].map((p) => path.resolve(here, p)).find((p) => existsSync(path.join(p, "meta/_journal.json")));
      if (!folder) throw new Error(`migrations folder not found near ${here}`);
      // app and every scaled worker boot at once after a pull; one migrates, the rest wait and find nothing to do
      const client = await pool.connect();
      try {
        await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK]);
        await migrate(drizzle(client, { schema }), { migrationsFolder: folder });
      } finally {
        await client.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK]).catch(() => {});
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function safeUrl(u: string) {
  try {
    const url = new URL(u);
    url.password = url.password ? "***" : "";
    return url.toString();
  } catch {
    return "<DATABASE_URL>";
  }
}
