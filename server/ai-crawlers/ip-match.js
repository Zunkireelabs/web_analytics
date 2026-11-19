import { isIP } from 'node:net';

// IPv4 and IPv6 CIDR matching with no dependency. Vendors publish their crawler addresses as CIDR lists (OpenAI, Anthropic,
// Perplexity and Apple are IPv4 only; Google mixes both), and an address is only believed to be a vendor's when it falls
// inside one. BigInt keeps the arithmetic exact for 128-bit IPv6 values.

function v4ToBig(s) {
  const p = s.split('.').map(Number);
  return (BigInt(p[0]) << 24n) | (BigInt(p[1]) << 16n) | (BigInt(p[2]) << 8n) | BigInt(p[3]);
}

function v6ToBig(raw) {
  let s = raw.split('%')[0].toLowerCase(); // a zone id (fe80::1%eth0) is not part of the address
  const tail4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:1.2.3.4 style tail
  if (tail4) {
    const v = v4ToBig(tail4[2]);
    s = `${tail4[1]}${((v >> 16n) & 0xffffn).toString(16)}:${(v & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (rest === null) groups = head;
  else {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  }
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

/** { family: 4|6, value: BigInt } or null. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) is read as the IPv4 it carries. */
export function parseIp(text) {
  const s = String(text ?? '').trim();
  const kind = isIP(s);
  if (kind === 4) return { family: 4, value: v4ToBig(s) };
  if (kind === 6) {
    const value = v6ToBig(s);
    if (value === null) return null;
    if ((value >> 32n) === 0xffffn) return { family: 4, value: value & 0xffffffffn };
    return { family: 6, value };
  }
  return null;
}

/** { family, base, bits } or null for anything that is not a valid CIDR. A bare address is a /32 (or /128). */
export function parseCidr(text) {
  const s = String(text ?? '').trim();
  const [addr, len, extra] = s.split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  const wasMapped = isIP(addr) === 6 && ip.family === 4; // "::ffff:1.2.3.4/120" counts bits from the v6 side
  let bits = len === undefined ? max : (/^\d+$/.test(len) ? Number(len) : NaN);
  if (wasMapped && len !== undefined) bits -= 96;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const shift = BigInt(max - bits);
  return { family: ip.family, base: (ip.value >> shift) << shift, bits };
}

export function cidrContains(cidr, ip) {
  if (!cidr || !ip || cidr.family !== ip.family) return false;
  const max = cidr.family === 4 ? 32 : 128;
  const shift = BigInt(max - cidr.bits);
  return (ip.value >> shift) << shift === cidr.base;
}

/** Compile CIDR strings once; the returned function says whether an address text is inside any of them. */
export function makeMatcher(cidrTexts) {
  const cidrs = (cidrTexts || []).map(parseCidr).filter(Boolean);
  return (ipText) => {
    const ip = parseIp(ipText);
    return ip ? cidrs.some((c) => cidrContains(c, ip)) : false;
  };
}

const NON_PUBLIC = makeMatcher([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
  '::1/128', '::/128', 'fc00::/7', 'fe80::/10',
]);

/** True for loopback, private, link-local and similar addresses: a real vendor crawler never arrives from one. */
export const isNonPublicIp = (ipText) => NON_PUBLIC(ipText);
