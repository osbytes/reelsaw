import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/** Thrown with a sentence a user can act on. */
export class UnsafeUrlError extends Error {}

const INSIDE =
  "That address points inside this server's network, so it was not fetched. Use a public link, or ask the admin to set ALLOW_PRIVATE_SOURCE_URLS=true.";

/** Names that are internal by convention, whatever they resolve to. */
export function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "host.docker.internal" || h.endsWith(".internal") || h === "metadata" || h.endsWith(".local");
}

function ipv4Blocked(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 || // unspecified / "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The eight 16-bit groups of an IPv6 address (handles `::` and a dotted IPv4 tail); null when it does not parse. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const fill = halves.length === 1 ? [] : Array.from({ length: 8 - head.length - tail.length }, () => "0");
  return [...head, ...fill, ...tail].map((g) => parseInt(g, 16));
}

const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

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
  // tunnels that carry an IPv4 address: 6to4 (2002:AABB:CCDD::/48) and NAT64 (64:ff9b::/96, RFC 6052). A private IPv4 inside
  // one reaches that private host through a gateway; 64:ff9b:1::/48 is the local-use NAT64 prefix and is never public.
  const g = ipv6Groups(l);
  if (g) {
    if (g[0] === 0x2002 && ipv4Blocked(v4(g[1]!, g[2]!))) return true;
    if (g[0] === 0x64 && g[1] === 0xff9b) {
      if (g[2] === 1) return true;
      if (g.slice(2, 6).every((x) => x === 0) && ipv4Blocked(v4(g[6]!, g[7]!))) return true;
    }
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
  lookup?: ((host: string) => Promise<Array<{ address: string }>>) | undefined;
}

/**
 * Throws UnsafeUrlError unless `raw` is an http(s) URL with no embedded credentials whose host is
 * not, and does not resolve to, an address inside this server's network.
 * Residual risk: this only checks the address now. A caller that then fetches with its own resolver can be
 * rebound between check and fetch, so server-side fetches go through `fetchPublic`. yt-dlp resolves and follows
 * redirects itself; see SECURITY.md, "URL sources and your network".
 */
export async function assertPublicHttpUrl(raw: string, opts: SafeUrlOptions = {}): Promise<URL> {
  return (await resolvePublicHttpUrl(raw, opts)).url;
}

/** `assertPublicHttpUrl`, plus the address that passed the check (null for an IP literal or when private links are allowed). */
export async function resolvePublicHttpUrl(raw: string, opts: SafeUrlOptions = {}): Promise<{ url: URL; address: string | null }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That is not a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http and https links can be used as a source.");
  if (url.username || url.password) throw new UnsafeUrlError("Links with a username or password in them are not accepted.");
  if (opts.allowPrivate) return { url, address: null };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isInternalHostname(host)) throw new UnsafeUrlError(INSIDE);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(INSIDE);
    return { url, address: null };
  }
  const lookup = opts.lookup ?? ((h) => dns.lookup(h, { all: true }));
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new UnsafeUrlError(`Could not find the address "${host}".`);
  }
  const first = addrs[0];
  if (!first || addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError(INSIDE);
  return { url, address: first.address };
}

/** What callers use of a response: spelled out so the undici and DOM `Response` types (the web build reads these files too) both fit. */
export interface PublicResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: { cancel(): Promise<void>; getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>; cancel(): Promise<void> } } | null;
}

/** The body's chunks, in order. Stops reading (and the download) if the consumer stops. */
export async function* bodyChunks(res: PublicResponse): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export interface FetchPublicOptions extends SafeUrlOptions {
  /** Redirects to follow, each re-validated. Default 5. */
  maxRedirects?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Injectable for tests: called instead of the network with the validated URL (and the pinned address). */
  fetch?:
    | ((url: URL, init: { redirect: "manual"; signal?: AbortSignal; headers?: Record<string, string> }, pinned: string | null) => Promise<PublicResponse>)
    | undefined;
}

/** A dispatcher that connects to `address` whatever the hostname resolves to now; TLS still checks the certificate against the hostname. */
function pinnedAgent(address: string): Agent {
  const family = net.isIP(address);
  return new Agent({
    keepAliveTimeout: 1000,
    keepAliveMaxTimeout: 1000,
    connect: {
      lookup: (_host, options, cb) => {
        if (options.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
    },
  });
}

/**
 * GET `raw` from a public host and nothing else. The name is resolved once and checked (`resolvePublicHttpUrl`),
 * then the connection goes to that very address, so DNS rebinding between the check and the connect cannot
 * point it inside the network. Redirects are followed by hand (up to `maxRedirects`), every hop checked and
 * pinned the same way. Returns the final response and URL; the caller reads the body (bound it) and
 * decides what a non-2xx means.
 */
export async function fetchPublic(raw: string, opts: FetchPublicOptions = {}): Promise<{ res: PublicResponse; url: URL }> {
  const max = opts.maxRedirects ?? 5;
  let next = raw;
  for (let hop = 0; ; hop++) {
    const { url, address } = await resolvePublicHttpUrl(next, opts);
    const init = { redirect: "manual" as const, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.headers ? { headers: opts.headers } : {}) };
    // one agent per hop: close() lets the in-flight request (and the body the caller reads) finish, then frees the sockets
    const agent = !opts.fetch && address ? pinnedAgent(address) : undefined;
    const closeAgent = () => void agent?.close().catch(() => undefined);
    let res: PublicResponse;
    try {
      res = opts.fetch ? await opts.fetch(url, init, address) : await undiciFetch(url, { ...init, ...(agent ? { dispatcher: agent } : {}) });
    } catch (err) {
      closeAgent();
      throw err;
    }
    closeAgent();
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= max) throw new TooManyRedirectsError();
      next = new URL(location, url).toString();
      continue;
    }
    return { res, url };
  }
}

export class TooManyRedirectsError extends Error {
  constructor() {
    super("Too many redirects");
  }
}
