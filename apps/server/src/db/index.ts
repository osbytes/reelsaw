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
  /** size of `pool` (DB_POOL_MAX) */
  poolMax: number;
  /** A second pool on the same database for work that holds a connection for a long time (model-call slots), so it cannot starve `pool`. Closed with `close()`. */
  extraPool(max: number): pg.Pool;
  close(): Promise<void>;
}

/** pg_advisory_lock key for migrations (any constant no other lock uses). */
const MIGRATE_LOCK = 727_011;

/** Give up connecting after this long instead of queueing forever behind a saturated or unreachable server. */
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * A session left inside a transaction this long is ended by Postgres (its locks and snapshot are freed).
 * Set per connection, not as a global `statement_timeout`: migrations and bulk updates may run long.
 */
const IDLE_IN_TRANSACTION_MS = 5 * 60_000;

function makePool(connectionString: string, max: number, log: Logger): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // an idle client's connection dropped; the pool discards it and opens another, so this recovers by itself
  pool.on("error", (err) => log.warn({ err }, "pg pool error"));
  // queued ahead of the first query the pool hands out on this connection
  pool.on("connect", (client) => {
    client
      .query(`set idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_MS}`)
      .catch((err) => log.warn({ err }, "could not set idle_in_transaction_session_timeout"));
  });
  return pool;
}

export function createDatabase(connectionString: string, log: Logger, opts: { poolMax?: number } = {}): Database {
  const poolMax = opts.poolMax ?? 10;
  const pool = makePool(connectionString, poolMax, log);
  const extraPools = new Set<pg.Pool>();
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
        // a database volume keeps the password it was created with: a fresh .env over an old volume
        const hint = /password authentication failed/i.test(detail)
          ? " (the database volume was created with another password; re-run the installer, or see Troubleshooting in deploy/README.md)"
          : "";
        throw new Error(`cannot connect to Postgres at ${safeUrl(connectionString)}: ${detail}${hint}`);
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
    poolMax,
    extraPool(max) {
      const extra = makePool(connectionString, max, log);
      extraPools.add(extra);
      return extra;
    },
    close: async () => {
      await Promise.all([...extraPools].map((p) => p.end().catch(() => {})));
      await pool.end();
    },
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
