/**
 * Where a file under apps/server/assets lives at run time. Not `process.cwd()`: the image runs from
 * /app with the assets at /app/server/assets, while tests, evals and `pnpm dev` run from apps/server.
 * Tried relative to this module first (src/lib or dist/lib → ../../assets), then from the working
 * directory; the first that exists wins, else the module-relative path (so an error names it).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function bundledAssetPath(rel: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../assets", rel),
    path.resolve(here, "../assets", rel),
    path.resolve(here, "../../../assets", rel),
    path.resolve(process.cwd(), "assets", rel),
    path.resolve(process.cwd(), "apps/server/assets", rel),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}
