import { defineConfig, devices } from "@playwright/test";

/**
 * Browser checks against a running stack (CI's stack job, or `docker compose up` locally): every main screen at
 * desktop and phone width, with axe. REELSAW_URL picks the instance; nothing here starts one.
 * pnpm --filter @reelsaw/web e2e
 */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // AXE_UPDATE rewrites one baseline file from every test: one worker, so the writes do not race
  ...(process.env["AXE_UPDATE"] ? { workers: 1 } : {}),
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["list"], ["github"]] : "list",
  use: {
    baseURL: process.env["REELSAW_URL"] ?? "http://localhost:3100",
    storageState: "e2e/.auth/state.json",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
