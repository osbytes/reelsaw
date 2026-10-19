/**
 * The hosted service, when it exists: NEXT_PUBLIC_HOSTED_URL (e.g. https://app.reelsaw.com). Unset, the site
 * says nothing about a hosted plan: no pricing / terms / privacy pages, no links, self-hosted-only copy.
 * Read at build time; set it on Vercel and redeploy when app.reelsaw.com goes live.
 */
const hostedUrl = process.env.NEXT_PUBLIC_HOSTED_URL?.replace(/\/+$/, "") || null;
export const HOSTED = !!hostedUrl;

export const SITE = {
  name: "Reelsaw",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://reelsaw.com").replace(/\/+$/, ""),
  hosted: HOSTED,
  title: "Reelsaw: self-hosted, AI-powered video clipper",
  description:
    "Turn long videos into vertical 9:16 clips on your own hardware. Reelsaw transcribes, picks the most clippable moments with an LLM, reframes speakers and burns in word-highlight captions. Open source (AGPL-3.0), fully local with no API keys or any AI provider you choose, one-command Docker install.",
  /** the hosted service (docs/specs/ee.md); only meaningful when `hosted` is true */
  app: hostedUrl ?? "https://app.reelsaw.com",
  github: "https://github.com/osbytes/reelsaw",
  releases: "https://github.com/osbytes/reelsaw/releases",
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
