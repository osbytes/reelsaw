// Runs every test that needs no running stack: the files that do not import ./helpers.js (whose
// db() / signUp() / BASE need Postgres and the app). `pnpm test` runs all of them against a local stack.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "test");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !/from\s+["']\.\/helpers(\.js)?["']/.test(readFileSync(path.join(dir, f), "utf8")))
  .map((f) => path.join("test", f));
console.log(`${files.length} stack-free test files`);
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
