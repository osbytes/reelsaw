/**
 * The visit's first touch, carried into the app. The site and the app are separate analytics projects, and a link
 * into the app only says which button was clicked (`utm_content`); what brought the visitor to reelsaw.com in the
 * first place (Google, Reddit, a ChatGPT answer) was lost at the hop. This keeps that first touch in the browser and
 * adds it to every link into the app as `site_ref` (the referring site, or the visit's own utm_source), `site_landing`
 * (the first page seen here) and `site_id` (this site's analytics id). The app keeps the first ones it sees and sends
 * them with the sign-up (apps/web lib/telemetry.ts; the names mirror ATTRIBUTION_PARAMS in packages/shared
 * attribution.ts, which this site cannot import: it is outside the pnpm workspace). Domains, paths and ids only.
 */
import { SITE } from "./site";

const KEY = "reelsaw.siteFirstTouch";

type FirstTouch = { site_ref: string; site_landing: string };

const own = (host: string) => host === new URL(SITE.url).hostname || host.endsWith(`.${new URL(SITE.url).hostname}`);

/** Record the first touch once per browser (a later visit does not replace it). Call on every page load. */
export function captureFirstTouch(): void {
  try {
    if (localStorage.getItem(KEY)) return;
    const q = new URLSearchParams(window.location.search);
    let ref = q.get("utm_source")?.trim() || "";
    if (!ref && document.referrer) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, "");
      if (!own(host)) ref = host;
    }
    const touch: FirstTouch = { site_ref: (ref || "$direct").slice(0, 200), site_landing: window.location.pathname.slice(0, 200) };
    localStorage.setItem(KEY, JSON.stringify(touch));
  } catch {
    // storage blocked: links go out with the button's tags only
  }
}

function firstTouch(): Partial<FirstTouch> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || typeof v !== "object") return {};
    const out: Partial<FirstTouch> = {};
    if ("site_ref" in v && typeof v.site_ref === "string") out.site_ref = v.site_ref;
    if ("site_landing" in v && typeof v.site_landing === "string") out.site_landing = v.site_landing;
    return out;
  } catch {
    return {};
  }
}

/** `href` (a link into the app) with the first touch and this site's analytics id added; any other link unchanged. */
export function decorateAppUrl(href: string, siteId?: string | null): string {
  if (!href.startsWith(SITE.app)) return href;
  try {
    const u = new URL(href);
    const t = firstTouch();
    if (t.site_ref && !u.searchParams.has("site_ref")) u.searchParams.set("site_ref", t.site_ref);
    if (t.site_landing && !u.searchParams.has("site_landing")) u.searchParams.set("site_landing", t.site_landing);
    if (siteId && !u.searchParams.has("site_id")) u.searchParams.set("site_id", siteId.slice(0, 200));
    return u.toString();
  } catch {
    return href;
  }
}
