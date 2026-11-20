/**
 * Public site constants. Hosted Reelsaw is a product fact (app.reelsaw.com): pricing, terms and
 * privacy are always on the site. NEXT_PUBLIC_HOSTED_URL only overrides the app URL (staging).
 */
export const SITE = {
  name: "Reelsaw",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://reelsaw.com").replace(/\/+$/, ""),
  title: "Reelsaw: AI video clipper, hosted or self-hosted",
  description:
    "Turn long videos into vertical 9:16 clips. Start free at app.reelsaw.com, first video free up to 60 minutes, or self-host the open-source (AGPL-3.0) build with no meter and no API keys. MCP included.",
  /** the hosted service (docs/specs/ee.md) */
  app: (process.env.NEXT_PUBLIC_HOSTED_URL ?? "https://app.reelsaw.com").replace(/\/+$/, ""),
  github: "https://github.com/osbytes/reelsaw",
  /** GitHub's own releases (zips, tags). The changelog page is `/releases`. */
  releases: "https://github.com/osbytes/reelsaw/releases",
  changelog: "/releases",
  issues: "https://github.com/osbytes/reelsaw/issues",
  docker: "https://github.com/osbytes/reelsaw/pkgs/container/reelsaw",
  osbytes: "https://www.osbytes.io",
  glama: "https://glama.ai/mcp/servers/osbytes/reelsaw",
  license: "https://github.com/osbytes/reelsaw/blob/main/LICENSE",
  contributing: "https://github.com/osbytes/reelsaw/blob/main/CONTRIBUTING.md",
  deployDocs: "https://github.com/osbytes/reelsaw/blob/main/deploy/README.md",
  layoutsDocs: "https://github.com/osbytes/reelsaw/blob/main/docs/LAYOUTS.md",
  mcpDocs: "https://github.com/osbytes/reelsaw#mcp-drive-reelsaw-from-an-agent",
  cliDocs: "https://github.com/osbytes/reelsaw#operator-cli",
  installSh: "curl -fsSL https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.sh | bash",
  installPs1: "irm https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.ps1 | iex",
} as const;

/**
 * A link into the hosted app, tagged with where on the site it was clicked. The site and the app are separate
 * analytics projects, so the UTM tags (kept as the app's first-touch properties) are what ties a sign-up to the site.
 */
export function appLink(path: string, cta: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ ...params, ...utmParams(cta) });
  return `${SITE.app}${path}?${q}`;
}

/** The UTM tags appLink adds, for a plain GET form into the app (the hero's link box). */
export function utmParams(cta: string): Record<string, string> {
  return { utm_source: "reelsaw.com", utm_medium: "website", utm_content: cta };
}

/**
 * `/signup?url=<link>`: the app remembers the link and opens New project with it after the first sign-in.
 * Mirrors SOURCE_URL_PARAM in packages/shared/src/new-project.ts (the site is outside the pnpm workspace).
 */
export const SOURCE_URL_PARAM = "url";
