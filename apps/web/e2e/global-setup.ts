import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { request, type FullConfig } from "@playwright/test";

/** One throwaway account through the real sign-up endpoint; its session is every test's storage state. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:3100";
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await ctx.post("/api/auth/sign-up/email", { data: { email, password: `pw-${randomUUID()}`, name: "E2E" } });
    if (res.ok()) break;
    // Better Auth limits sign-ups per instance; the stack suites may have just used the allowance
    if (res.status() === 429 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, (Number(res.headers()["x-retry-after"]) || 3) * 1000));
      continue;
    }
    throw new Error(`sign-up failed: ${res.status()} ${await res.text()}`);
  }
  const file = path.join(import.meta.dirname, ".auth", "state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ctx.storageState({ path: file });
  await ctx.dispose();
}
