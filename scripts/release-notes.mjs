#!/usr/bin/env node
/**
 * Release notes for a GitHub release: the "## <version>" section of apps/server/CHANGELOG.md, as
 * changesets wrote it. Run by release.yml and handed to the release as its body, so the release
 * page says what changed instead of "Reelsaw X.Y.Z".
 *
 * The changelog credits every entry ("Thanks @who!"). That stays for outside contributors and is
 * dropped for the maintainers listed below, whose names on every line are noise.
 *
 *   node scripts/release-notes.mjs 0.8.0            # prints markdown
 *   MAINTAINERS=alice,bob node scripts/release-notes.mjs 0.8.0
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAINTAINERS = (process.env.MAINTAINERS ?? "dillonstreator")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const REPO_URL = "https://github.com/osbytes/reelsaw";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/release-notes.mjs <version>   (e.g. 0.8.0)");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelog = fs.readFileSync(path.join(root, "apps/server/CHANGELOG.md"), "utf8");

/** The body of one "## <version>" section (up to the next "## "), or null when the changelog has none. */
export function sectionOf(md, v) {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${v}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

/** Drop " Thanks [@login](url)! -" for maintainers; keep it for everyone else. */
export function trimThanks(md, maintainers) {
  return md.replace(/ Thanks \[@([^\]]+)\]\([^)]*\)! -/g, (whole, login) => (maintainers.includes(String(login).toLowerCase()) ? "" : whole));
}

const section = sectionOf(changelog, version);
const body = section ? trimThanks(section, MAINTAINERS) : `_No changelog entry for ${version}._`;
process.stdout.write(
  `${body}\n\n---\n\n**Install or upgrade:** \`reelsaw-${version}.zip\` below holds the compose file and installer pinned to this release; an existing install runs \`docker compose pull && docker compose up -d\`. Details in [deploy/README.md](${REPO_URL}/blob/v${version}/deploy/README.md). Full history: [CHANGELOG.md](${REPO_URL}/blob/v${version}/apps/server/CHANGELOG.md).\n`,
);
