/**
 * A minutes refusal has a request form and a worker form (quota.ts): a request refuses with a QuotaError (a
 * TOO_MANY_REQUESTS answer with the upgrade offer on every surface), a worker fails the project with a
 * QuotaExceededError. The worker form thrown from a request is an internal error: the person sees "something went
 * wrong" instead of the refusal, and it is reported as a bug. Only the pipeline may use the worker forms.
 * Run: node --import tsx --test test/quota-sides.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** The worker forms: they throw (or are) a QuotaExceededError. */
const WORKER_FORMS = /\b(admitRanges|admitSource|new QuotaExceededError)\s*\(/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("minutes refusals on the right side", () => {
  it("leaves the worker forms to the pipeline (and quota.ts, which defines them)", () => {
    const offenders = files(src)
      .map((f) => path.relative(src, f).split(path.sep).join("/"))
      .filter((f) => !f.startsWith("pipeline/") && f !== "quota.ts")
      .filter((f) => WORKER_FORMS.test(readFileSync(path.join(src, f), "utf8")));
    assert.deepEqual(offenders, [], "a request path refuses with checkRanges / checkAnnouncedMinutes / predictAdmission (a QuotaError)");
  });
});
