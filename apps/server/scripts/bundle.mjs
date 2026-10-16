// Production bundle for the distributed image: first-party code (this app and @reelsaw/shared)
// inlined and minified into dist-bundle/{main,cli}.js with no source maps; npm dependencies stay
// external and are installed as a normal production node_modules.
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies)
  .filter((d) => !d.startsWith("@reelsaw/"))
  .flatMap((d) => [d, `${d}/*`]);
const outdir = new URL("../dist-bundle", import.meta.url).pathname;
rmSync(outdir, { recursive: true, force: true });

await build({
  entryPoints: { main: "src/main.ts", cli: "src/cli.ts" },
  outdir,
  bundle: true,
  splitting: true, // main and cli share one chunk set instead of two copies
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external,
  chunkNames: "chunks/[hash]",
  // CommonJS dependencies that call require() from inside the ESM bundle
  banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
  logLevel: "warning",
});
console.log(`bundled to ${outdir}`);
