import { githubReleases } from "@/lib/github";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

function xml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function GET() {
  const feed = await githubReleases();
  const items = (feed?.releases ?? [])
    .slice(0, 40)
    .map((r) => {
      const notes = r.notes.map((n) => `<li>${xml(n.text)}</li>`).join("");
      return `<item>
      <title>${xml(r.tag)}</title>
      <link>${SITE.url}/releases#${xml(r.tag)}</link>
      <guid isPermaLink="true">${SITE.url}/releases#${xml(r.tag)}</guid>
      <pubDate>${new Date(r.publishedAt).toUTCString()}</pubDate>
      <description><![CDATA[<p>${xml(r.summary)}</p>${notes ? `<ul>${notes}</ul>` : ""}]]></description>
    </item>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Reelsaw releases</title>
    <link>${SITE.url}/releases</link>
    <description>${xml("Published Reelsaw versions from GitHub.")}</description>
    ${items}
  </channel>
</rss>
`;
  return new Response(body, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
