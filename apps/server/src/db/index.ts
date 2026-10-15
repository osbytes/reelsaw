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
      const here = path.dirname(fileURLToPath(import.meta.url));
      await migrate(db, { migrationsFolder: path.resolve(here, "../../drizzle") }); // works from src/ and dist/
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
