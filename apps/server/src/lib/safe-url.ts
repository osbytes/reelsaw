import dns from "node:dns/promises";
import net from "node:net";

/** Thrown with a sentence a user can act on. */
export class UnsafeUrlError extends Error {}

const INSIDE = "That address points inside this server's network, so it was not fetched. Use a public link, or ask the admin to set ALLOW_PRIVATE_SOURCE_URLS=true.";

/** Names that are internal by convention, whatever they resolve to. */
export function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "host.docker.internal" || h.endsWith(".internal") || h === "metadata" || h.endsWith(".local");
}

function ipv4Blocked(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 || // unspecified / "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True for loopback, link-local, private, CGNAT, unique-local, unspecified and multicast addresses. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind !== 6) return true; // not an address we understand: refuse
  const l = ip.toLowerCase();
  const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(l); // IPv4-mapped / compatible
  if (mapped) return ipv4Blocked(mapped[1]!);
  // WHATWG URL writes [::ffff:169.254.169.254] as [::ffff:a9fe:a9fe]; the deprecated compatible form too
  const hexMapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(l.split(":")[0] || "0", 16);
  return (
    l === "::" ||
    l === "::1" ||
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // multicast
  );
}

export interface SafeUrlOptions {
  /** Self-hosters who ingest from a LAN NAS turn the check off (ALLOW_PRIVATE_SOURCE_URLS). */
  allowPrivate?: boolean;
  /** Injectable for tests. */
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
}

/**
 * Throws UnsafeUrlError unless `raw` is an http(s) URL with no embedded credentials whose host is
 * not, and does not resolve to, an address inside this server's network.
 * Residual risk: the check happens before the download; a public host that later redirects (or
 * rebinds DNS) to a private address is not caught, because yt-dlp does the fetching.
 */
export async function assertPublicHttpUrl(raw: string, opts: SafeUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That is not a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http and https links can be used as a source.");
  if (url.username || url.password) throw new UnsafeUrlError("Links with a username or password in them are not accepted.");
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isInternalHostname(host)) throw new UnsafeUrlError(INSIDE);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(INSIDE);
    return url;
  }
  const lookup = opts.lookup ?? ((h) => dns.lookup(h, { all: true }));
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new UnsafeUrlError(`Could not find the address "${host}".`);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError(INSIDE);
  return url;
}
