/**
 * Where a sign-up came from, first touch: the UTM tags the app was opened with and what the website (reelsaw.com)
 * knew about the visit before its link into the app (the referring site and the landing page there, and the
 * website's analytics id). The website adds these to every link into the app (`website/lib/site.ts` mirrors the
 * parameter names: it is outside the pnpm workspace); the app keeps the first ones it sees and sends them with the
 * sign-up request (ATTRIBUTION_HEADER), so the server's `user.signed_up` event carries them even when the address is
 * confirmed in another browser (a mail app's). Ids, tags, domains and paths only: never an email or a name.
 */
import { z } from "zod";

/**
 * The request header the sign-up form sends the first-touch attribution in: JSON of `Attribution`, percent-encoded
 * (`encodeAttributionHeader`), because a header value must be ISO-8859-1 and a campaign tag can be any text: a raw
 * emoji there makes the browser refuse to send the sign-up at all.
 */
export const ATTRIBUTION_HEADER = "x-reelsaw-attribution";

/** The ATTRIBUTION_HEADER value for `a`: ASCII whatever the tags hold. */
export function encodeAttributionHeader(a: Attribution): string {
  return encodeURIComponent(JSON.stringify(a));
}

/** URL parameters the app reads attribution from (the website's links carry the site_* ones). */
export const ATTRIBUTION_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "site_ref", "site_landing", "site_id"] as const;
export type AttributionParam = (typeof ATTRIBUTION_PARAMS)[number];

const tag = z.string().trim().min(1).max(200);

export const attributionSchema = z
  .object({
    utm_source: tag,
    utm_medium: tag,
    utm_campaign: tag,
    utm_content: tag,
    utm_term: tag,
    /** the site that sent the visitor to reelsaw.com (a domain: google.com, reddit.com, chatgpt.com), else "$direct" */
    site_ref: tag,
    /** the first page seen on reelsaw.com (a path) */
    site_landing: tag,
    /** the website's analytics distinct id, so the visit and the account can be joined */
    site_id: tag,
  })
  .partial();
export type Attribution = z.infer<typeof attributionSchema>;

/** The attribution in a URL's query, null when it has none. Values longer than the schema allows are cut, not dropped. */
export function attributionFromSearch(search: string): Attribution | null {
  const q = new URLSearchParams(search);
  const out: Attribution = {};
  for (const k of ATTRIBUTION_PARAMS) {
    const v = q.get(k)?.trim();
    if (v) out[k] = v.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

/** The ATTRIBUTION_HEADER value read back, null when it is missing, too long or not the shape (it is only a hint). */
export function parseAttributionHeader(value: string | null | undefined): Attribution | null {
  if (!value || value.length > 16_384) return null;
  try {
    const r = attributionSchema.safeParse(JSON.parse(decodeURIComponent(value)));
    return r.success && Object.keys(r.data).length ? r.data : null;
  } catch {
    return null;
  }
}
