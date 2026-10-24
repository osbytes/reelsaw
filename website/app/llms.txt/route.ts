import { COMPETITORS } from "@/content/competitors";
import { GUIDES } from "@/content/guides";
import { CHECKED } from "@/content/reelsaw";
import { SITE } from "@/lib/site";

/**
 * /llms.txt (https://llmstxt.org): a short Markdown map of the site for language models and the
 * agents that read it, built from the same content as the sitemap so it cannot drift from the pages.
 * Static: rendered once at build time.
 */
export const dynamic = "force-static";

export function GET() {
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.description}`,
    "",
    "Reelsaw is open-source (AGPL-3.0) software you run yourself with Docker Compose. It takes a long video (a YouTube link or an upload), transcribes it, asks a language model for the most clippable moments, reframes the speaker into 9:16 with face tracking, cuts verified fillers and false starts, burns in word-highlight captions and renders the clips. Every model (language, transcription, judge) is configurable: fully local with Ollama and a local Whisper, or any provider through the AI SDK. Everything a person can do in the app is also an MCP tool and a CLI command.",
    "",
    "## Install and run",
    "",
    `- [One-command install](${SITE.deployDocs}): \`${SITE.installSh}\``,
    `- [Docker image](${SITE.docker}): ghcr.io/osbytes/reelsaw, amd64 and arm64`,
    `- [Source and README](${SITE.github}): architecture, model configuration, accounts, settings precedence`,
    `- [Releases](${SITE.url}${SITE.changelog}): changelog and a 90-day shipping map, fed from GitHub`,
    `- [GitHub releases](${SITE.releases}): install zip per version`,
    "",
    "## For agents",
    "",
    `- [MCP server](${SITE.mcpDocs}): Streamable HTTP at /api/mcp on any instance, or the \`reelsaw mcp\` stdio bridge from the image; every project, clip, library and admin operation is a tool`,
    `- [Operator CLI](${SITE.cliDocs}): the same operations from a shell inside the container`,
    `- [MCP registry listing](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.osbytes/reelsaw)`,
    `- [Glama](${SITE.glama})`,
    "",
    "## Guides",
    "",
    ...GUIDES.map((g) => `- [${g.h1}](${SITE.url}/${g.slug}): ${g.metaDescription}`),
    "",
    "## Comparisons",
    "",
    `- [Alternatives overview](${SITE.url}/alternatives): feature-by-feature against hosted clippers, pricing checked ${CHECKED}`,
    ...COMPETITORS.map((c) => `- [Reelsaw vs ${c.name}](${SITE.url}/alternatives/${c.slug}): ${c.metaDescription}`),
    "",
    ...(SITE.hosted
      ? ["## Hosted service", "", `- [Pricing](${SITE.url}/pricing)`, `- [Terms](${SITE.url}/terms)`, `- [Privacy](${SITE.url}/privacy)`, ""]
      : []),
    "## Project",
    "",
    `- [Layouts and reframing](${SITE.layoutsDocs})`,
    `- [Contributing](${SITE.contributing})`,
    `- [Issues](${SITE.issues})`,
    `- [License (AGPL-3.0)](${SITE.license})`,
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
