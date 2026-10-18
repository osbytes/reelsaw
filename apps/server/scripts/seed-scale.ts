/**
 * Scale fixture: inserts N users / projects / clips / events straight into Postgres so list,
 * search and replay work can be measured at 1k projects / 50k clips before and after a change
 * (docs/specs/scale.md, docs/TROUBLESHOOTING.md "Measuring at scale").
 *
 *   SEED_SCALE=1 DATABASE_URL=postgres://reelsaw:reelsaw@localhost:5442/reelsaw \
 *     npx tsx scripts/seed-scale.ts [--users 20] [--projects 1000] [--clips 50] [--hours 2] [--events 600] [--clean]
 *
 * Refuses to run without SEED_SCALE=1 (it writes thousands of rows) and without an explicit
 * DATABASE_URL. Everything it creates has an id starting with "seed-", and `--clean` removes
 * exactly that (users cascade to everything under them). It writes no files: media keys point
 * at objects that do not exist.
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { like } from "drizzle-orm";
import { projectSettingsSchema } from "@reelsaw/shared";
import { schema } from "../src/db/index.js";

if (process.env.SEED_SCALE !== "1") {
  console.error("refusing to run: set SEED_SCALE=1 (this inserts a lot of rows into DATABASE_URL)");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("set DATABASE_URL explicitly (no default, so this never lands on the wrong database)");
  process.exit(1);
}

const args = process.argv.slice(2);
const num = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const USERS = num("users", 20);
const PROJECTS = num("projects", 1000);
const CLIPS = num("clips", 50); // per project
const HOURS = num("hours", 2); // length of the longest source; others are 5-100% of it
const EVENTS = num("events", 600); // per project (three quarters are progress ticks, as in real runs)
const WORDS_PER_SEC = 3.3; // measured on the bench database

// deterministic, so two runs produce the same data
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const VOCAB = "so and the we you they really think about people because actually just going want make know right when what how why from video clip story money design build ship learn team company product market customer problem solution weekend morning decision hard simple honest fast slow".split(" ");
const sentence = (n = 6 + Math.floor(rnd() * 10)) => Array.from({ length: n }, () => pick(VOCAB)).join(" ");
const title = () => sentence(3 + Math.floor(rnd() * 5)).replace(/^./, (c) => c.toUpperCase());

async function insertBatches<T>(rows: T[], size: number, fn: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

const pool = new pg.Pool({ connectionString: url, max: 4 });
const db = drizzle(pool, { schema });

if (args.includes("--clean")) {
  await db.delete(schema.projects).where(like(schema.projects.id, "seed-%")); // also ones reassigned to a real user
  const r = await db.delete(schema.user).where(like(schema.user.id, "seed-%"));
  await pool.query("delete from llm_usage where user_id like 'seed-%'");
  console.log(`removed seeded users (${r.rowCount}) and everything under them`);
  await pool.end();
  process.exit(0);
}

const settings = projectSettingsSchema.parse({});
const t0 = Date.now();
const users = Array.from({ length: USERS }, (_, i) => ({ id: `seed-u${i}`, name: `Seed User ${i}`, email: `seed-${i}@example.test`, approvedAt: new Date() }));
await insertBatches(users, 500, (b) => db.insert(schema.user).values(b).onConflictDoNothing());

const now = Date.now();
let nProjects = 0;
let nClips = 0;
let nEvents = 0;
let nWords = 0;
for (let p0 = 0; p0 < PROJECTS; p0 += 50) {
  const projects: (typeof schema.projects.$inferInsert)[] = [];
  const transcripts: (typeof schema.transcripts.$inferInsert)[] = [];
  const clips: (typeof schema.clips.$inferInsert)[] = [];
  const events: (typeof schema.projectEvents.$inferInsert)[] = [];
  for (let i = p0; i < Math.min(PROJECTS, p0 + 50); i++) {
    const id = `seed-p${i}`;
    const dur = Math.round(HOURS * 3600 * (0.05 + rnd() * 0.95));
    const created = new Date(now - Math.floor(rnd() * 180 * 86_400_000));
    projects.push({
      id,
      userId: users[i % USERS]!.id,
      title: title(),
      sourceType: "url",
      sourceUrl: `https://www.youtube.com/watch?v=seed${i}`,
      sourceMeta: { thumbnail: `https://example.test/t/${i}.jpg` },
      durationSec: dur,
      width: 1920,
      height: 1080,
      status: "done",
      sourceBytes: dur * 400_000,
      settings,
      createdAt: created,
      updatedAt: new Date(created.getTime() + 3_600_000),
    });
    // words: {text,start,end}, the transcriber's shape and size (rawWords duplicates it, as in real rows)
    const nw = Math.round(dur * WORDS_PER_SEC);
    const words = Array.from({ length: nw }, (_, k) => ({ text: pick(VOCAB), start: Number((k / WORDS_PER_SEC).toFixed(2)), end: Number(((k + 0.8) / WORDS_PER_SEC).toFixed(2)) }));
    const segments = Array.from({ length: Math.ceil(dur / 6) }, (_, k) => ({ text: sentence(18), start: k * 6, end: k * 6 + 6 }));
    nWords += nw;
    transcripts.push({ projectId: id, language: "en", text: sentence(Math.min(nw, 2000)), words, rawWords: words, flags: [], deletedFlags: [], segments });
    for (let c = 0; c < CLIPS; c++) {
      const start = Math.floor(rnd() * Math.max(1, dur - 60));
      const cid = `seed-c${i}-${c}`;
      clips.push({
        id: cid,
        projectId: id,
        index: c,
        title: title(),
        hook: sentence(10),
        startSec: start,
        endSec: start + 20 + Math.floor(rnd() * 40),
        score: Number((rnd() * 10).toFixed(1)),
        reasoning: sentence(40),
        caption: sentence(30),
        hashtags: ["#seed", "#scale", "#clips"],
        status: "done",
        outputKey: `clips/${id}/${cid}.mp4`,
        thumbnailKey: `clips/${id}/${cid}.jpg`,
        createdAt: created,
        updatedAt: created,
      });
    }
    for (let e = 0; e < EVENTS; e++) {
      const progress = e % 4 !== 3;
      events.push({
        projectId: id,
        type: progress ? "stage.progress" : "clip.done",
        payload: progress ? { stage: "render", progress: (e % 100) / 100, message: "Rendering" } : { clipId: `seed-c${i}-${e % Math.max(1, CLIPS)}`, index: e % Math.max(1, CLIPS) },
        createdAt: new Date(created.getTime() + e * 1500),
      });
    }
    nProjects++;
  }
  await insertBatches(projects, 200, (b) => db.insert(schema.projects).values(b).onConflictDoNothing());
  await insertBatches(transcripts, 10, (b) => db.insert(schema.transcripts).values(b).onConflictDoNothing());
  await insertBatches(clips, 1000, (b) => db.insert(schema.clips).values(b).onConflictDoNothing());
  await insertBatches(events, 2000, (b) => db.insert(schema.projectEvents).values(b));
  nClips += clips.length;
  nEvents += events.length;
  process.stdout.write(`\r${nProjects}/${PROJECTS} projects, ${nClips} clips, ${nEvents} events`);
}
await pool.query("analyze");
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${USERS} users, ${nProjects} projects, ${nClips} clips, ${nEvents} events, ${nWords} words`);
console.log("remove with: SEED_SCALE=1 DATABASE_URL=... npx tsx scripts/seed-scale.ts --clean");
await pool.end();
