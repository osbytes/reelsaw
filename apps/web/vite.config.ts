import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { lingui } from "@lingui/vite-plugin";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // lingui: compiles .po catalogues on import and expands the Trans / t macros natively (no Babel); configPath so the
  // config loads whatever the working directory (Knip reads this file from the repo root)
  plugins: [react(), lingui({ macroTransform: true, configPath: fileURLToPath(new URL("./lingui.config.ts", import.meta.url)) }), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false },
      "/media": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
  // maps with no sourceMappingURL: a release build uploads them to Sentry and deletes them (Dockerfile); none are served
  build: { outDir: "dist", sourcemap: "hidden" },
});
