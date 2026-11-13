/**
 * IP addresses and CIDR ranges as numbers, for the outbound-URL guard (safe-url.ts) and the sign-up rules
 * (signup-rules.ts). An IPv4 address mapped into IPv6 (`::ffff:1.2.3.4`) is treated as the IPv4 address
 * everywhere, so a rule, a proxy header and a log line agree on what one client is.
 */
import net from "node:net";

/** The eight 16-bit groups of an IPv6 address (handles `::` and a dotted IPv4 tail); null when it does not parse. */
export function ipv6Groups(ip: string): number[] | null {
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

/** A range of addresses: `prefix` leading bits of `net` (an address is a range of 32 or 128 bits). */
export type IpRange = { family: 4 | 6; net: bigint; prefix: number };

const WIDTH = { 4: 32, 6: 128 } as const;

/** An address as a number, IPv4-mapped IPv6 folded to IPv4; null when it is not an address. */
export function parseIp(ip: string): { family: 4 | 6; value: bigint } | null {
  const s = ip.trim();
  const family = net.isIP(s);
  if (family === 4) return { family: 4, value: s.split(".").reduce((n, o) => (n << 8n) | BigInt(Number(o)), 0n) };
  if (family !== 6) return null;
  const groups = ipv6Groups(s);
  if (!groups) return null;
  const value = groups.reduce((n, g) => (n << 16n) | BigInt(g), 0n);
  return value >> 32n === 0xffffn ? { family: 4, value: value & 0xffffffffn } : { family: 6, value };
}

const mask = (family: 4 | 6, prefix: number) => {
  const width = BigInt(WIDTH[family]);
  return ((1n << width) - 1n) ^ ((1n << (width - BigInt(prefix))) - 1n);
};

/**
 * `203.0.113.7`, `203.0.113.5/24`, `2001:DB8::/32`, `::ffff:203.0.113.0/120` as one canonical range: host bits
 * cleared and a mapped IPv4 range turned into IPv4 (so the last two are `203.0.113.0/24`). A sentence when it
 * does not parse.
 */
export function parseRange(raw: string): IpRange | { error: string } {
  const [addr = "", bits, extra] = raw.trim().split("/");
  const value = parseIp(addr);
  if (!value || extra !== undefined) return { error: `“${raw}” is not an IP address or a range like 203.0.113.0/24.` };
  const typed = net.isIP(addr.trim()) === 6 ? 6 : 4;
  const max = WIDTH[typed];
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return { error: `“${raw}”: the range after / must be 0-${max}.` };
  let prefix = bits === undefined ? max : Number(bits);
  if (prefix > max) return { error: `“${raw}”: the range after / must be 0-${max}.` };
  if (typed === 6 && value.family === 4) {
    // a mapped IPv4 range: only the part inside ::ffff:0:0/96 means anything to an IPv4 client
    if (prefix < 96) return { error: `“${raw}” is wider than the IPv4-mapped block (::ffff:0:0/96). Write the IPv4 range instead.` };
    prefix -= 96;
  }
  return { family: value.family, net: value.value & mask(value.family, prefix), prefix };
}

/** The canonical text of a range: dotted IPv4 or RFC 5952 IPv6, `/prefix` only when it is not a single address. */
export function formatRange(r: IpRange): string {
  let addr: string;
  if (r.family === 4) addr = [24n, 16n, 8n, 0n].map((s) => String((r.net >> s) & 255n)).join(".");
  else {
    const groups = Array.from({ length: 8 }, (_, i) => Number((r.net >> BigInt(112 - i * 16)) & 0xffffn));
    // the longest run of two or more zero groups becomes `::` (the first one on a tie)
    let best = { at: -1, len: 1 };
    for (let i = 0; i < 8; ) {
      if (groups[i] !== 0) {
        i++;
        continue;
      }
      let j = i;
      while (j < 8 && groups[j] === 0) j++;
      if (j - i > best.len) best = { at: i, len: j - i };
      i = j;
    }
    const hex = groups.map((g) => g.toString(16));
    addr = best.at < 0 ? hex.join(":") : `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.len).join(":")}`;
  }
  return r.prefix === WIDTH[r.family] ? addr : `${addr}/${r.prefix}`;
}

/** Whether an address (any form, mapped IPv4 included) is inside a range. */
export function inRange(r: IpRange, ip: string): boolean {
  const v = parseIp(ip);
  return !!v && v.family === r.family && (v.value & mask(r.family, r.prefix)) === r.net;
}
