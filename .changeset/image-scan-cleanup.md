---
"@reelsaw/server": patch
---
Leaner, cleaner container image: the image no longer ships tools the app never runs (drizzle-kit, tsx and their esbuild binaries, npm, corepack, yarn, gosu), which cleared every fixable vulnerability the image scanner reported. The entrypoint, `reelsaw` CLI and health check drop to the `node` user with `setpriv` instead of `gosu`.
