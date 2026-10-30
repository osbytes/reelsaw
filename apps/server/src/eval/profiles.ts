/**
 * Matrix profiles: named sets of env overrides (model ids, toggles) that the eval runner applies on
 * top of the repo .env, one pass per profile. Keys stay in the .env; a profile only says which
 * models and settings to run with.
 *
 *   { "profiles": { "cloud-cheap": { "AI_MODEL": "gateway:openai/gpt-4o-mini" }, ... } }
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Profile {
  name: string;
  env: Record<string, string>;
}

interface MatrixFile {
  profiles: Record<string, Record<string, string>>;
}

/** Profiles from `--matrix file` (optionally filtered by `--profiles a,b`) and/or one ad-hoc profile from `--set K=V`. */
export function parseProfiles(opts: { matrix?: string | undefined; profiles?: string | undefined; set: string[] }): Profile[] {
  const out: Profile[] = [];
  if (opts.matrix) {
    const parsed = JSON.parse(readFileSync(path.resolve(opts.matrix), "utf8")) as MatrixFile;
    if (!parsed.profiles || typeof parsed.profiles !== "object") throw new Error(`${opts.matrix}: expected { "profiles": { "<name>": { "ENV": "value" } } }`);
    const only = opts.profiles?.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = only?.filter((n) => !parsed.profiles[n]) ?? [];
    if (missing.length) throw new Error(`unknown profile(s) ${missing.join(", ")}; the matrix defines: ${Object.keys(parsed.profiles).join(", ")}`);
    for (const [name, env] of Object.entries(parsed.profiles)) {
      if (only && !only.includes(name)) continue;
      for (const [k, v] of Object.entries(env)) if (typeof v !== "string") throw new Error(`${opts.matrix}: profile "${name}" key ${k} must be a string`);
      out.push({ name, env });
    }
  }
  if (opts.set.length) {
    const env: Record<string, string> = {};
    for (const kv of opts.set) {
      const i = kv.indexOf("=");
      if (i <= 0) throw new Error(`--set expects KEY=VALUE, got "${kv}"`);
      env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    out.push({ name: Object.values(env).join("+").replace(/[^A-Za-z0-9._:+/-]+/g, "_"), env });
  }
  return out;
}
