/**
 * Public site constants. Hosted Reelsaw is a product fact (app.reelsaw.com): pricing, terms and
 * privacy are always on the site. NEXT_PUBLIC_HOSTED_URL only overrides the app URL (staging).
 */
export const SITE = {
  name: "Reelsaw",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://reelsaw.com").replace(/\/+$/, ""),
  title: "Reelsaw: AI video clipper you self-host or run hosted",
  description:
    "Turn long videos into vertical 9:16 clips. Self-host with no meter, or use app.reelsaw.com (Free, then $12 / $29 / $59 a month). Open source (AGPL-3.0), fully local with no API keys or any AI provider, MCP on every plan.",
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
