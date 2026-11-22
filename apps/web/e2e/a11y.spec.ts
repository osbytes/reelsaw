/**
 * Accessibility ratchet (docs/UI.md, "Accessibility debt"): axe (WCAG 2.2 A and AA) on every main screen at desktop
 * and phone width. The rules each screen still breaks are in axe-baseline.json; a rule that is not there fails the
 * test, and so does a listed rule that no longer fires, so the baseline is lowered in the change that fixed it.
 * AXE_UPDATE=1 rewrites the baseline (only ever to lower it, in review).
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASELINE = path.join(import.meta.dirname, "axe-baseline.json");
const SCREENS = [
  { name: "projects", path: "/" },
  { name: "new-project", path: "/new" },
  { name: "library", path: "/library" },
  { name: "templates", path: "/templates" },
  { name: "settings", path: "/settings" },
];

const baseline: Record<string, string[]> = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};

for (const screen of SCREENS) {
  test(`${screen.name} has no new accessibility violations`, async ({ page }, info) => {
    await page.goto(screen.path);
    await page.waitForLoadState("networkidle");
    // nothing is still loading: the skeleton region announces "Loading…" until its query resolves
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const key = `${screen.name}@${info.project.name}`;
    const now = [...new Set(results.violations.map((v) => v.id))].sort();
    if (process.env.AXE_UPDATE) {
      const current: Record<string, string[]> = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
      current[key] = now;
      fs.writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(current).sort()), null, 2)}\n`);
      return;
    }
    const known = new Set(baseline[key] ?? []);
    const added = results.violations
      .filter((v) => !known.has(v.id))
      .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} element(s), e.g. ${v.nodes[0]?.target.join(" ")}`);
    const fixed = [...known].filter((id) => !now.includes(id));
    console.log(`AXE ${key} ${JSON.stringify(now)}`);
    expect(added, `new violations on ${key}`).toEqual([]);
    expect(fixed, `fixed on ${key}: remove them from e2e/axe-baseline.json`).toEqual([]);
  });
}
