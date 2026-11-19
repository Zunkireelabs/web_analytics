import { isIP } from 'node:net';

// One access-log line -> the few fields this feature needs. Handles the nginx and Apache "combined" format, with or without
// the extra trailing field nginx's default `main` format adds (the X-Forwarded-For header):
//
//   172.18.0.3 - - [17/Nov/2026:19:28:09 +0000] "GET /robots.txt HTTP/1.1" 200 650 "-" "<user agent>" "51.8.102.237"
//
// Returns null for anything that is not a normal request line (scanner garbage, truncated lines, other log formats), so a
// bad line is skipped and counted, never guessed at.
//
// What is deliberately NOT returned: the referrer, and the query string. Query strings carry tokens and personal data
// (?email=...), and nothing here needs them. The client address is returned so the caller can check it against a vendor's
// published list, and it is the caller's job to drop it afterwards (aggregate.js never stores it).

const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-) "[^"]*" "([^"]*)"(?: "([^"]*)")?\s*$/;
const TIME = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const MAX_PATH = 200;

/** "17/Nov/2026:19:28:09 +0000" -> a Date in UTC (the offset in the line is applied), or null. */
export function parseLogTime(text) {
  const m = TIME.exec(text);
  if (!m || !(m[2] in MONTHS)) return null;
  const [, d, , y, hh, mm, ss, sign, oh, om] = m;
  const offsetMin = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  const ms = Date.UTC(Number(y), MONTHS[m[2]], Number(d), Number(hh), Number(mm), Number(ss)) - offsetMin * 60000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The path without query string or fragment, control characters removed, capped in length. */
export function cleanPath(target) {
  const path = String(target).split(/[?#]/)[0].replace(/[\u0000-\u001f\u007f]/g, '');
  return path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path;
}

// "1.2.3.4", "1.2.3.4:5678", "[2001:db8::1]:443", "2001:db8::1" -> a bare address, or null.
function bareAddress(token) {
  let t = String(token).trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(t);
  if (bracket) t = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(t)) t = t.slice(0, t.lastIndexOf(':'));
  return isIP(t) ? t : null;
}

/**
 * The address the request really came from.
 *
 * Behind a proxy (superrank-web sits behind Traefik) the first field is the proxy's own address, and the visitor is the
 * LAST entry of X-Forwarded-For: each proxy appends the address it received the request from, so entries to the left can
 * be forged by the client and the rightmost one cannot. With no forwarded header at all (nginx facing the internet
 * directly, or Apache combined format) the first field is the visitor.
 * A forwarded header that is present but unreadable gives null: a made-up address must never verify a crawler.
 */
export function clientAddress(remoteAddr, forwardedFor) {
  const hasForwarded = forwardedFor != null && forwardedFor !== '' && forwardedFor !== '-';
  if (!hasForwarded) return bareAddress(remoteAddr);
  const entries = forwardedFor.split(',').map((e) => e.trim()).filter(Boolean);
  return entries.length ? bareAddress(entries[entries.length - 1]) : null;
}

export function parseLine(line) {
  const m = LINE.exec(String(line ?? '').trimEnd());
  if (!m) return null;
  const [, remoteAddr, time, request, status, bytes, ua, forwardedFor] = m;
  const when = parseLogTime(time);
  if (!when) return null;
  const parts = request.split(' ');
  const method = parts[0];
  const target = parts[1];
  if (!/^[A-Z]{3,10}$/.test(method) || !target || target[0] !== '/') return null;
  return {
    at: when,
    day: when.toISOString().slice(0, 10), // UTC day, so the same moment is the same day on every server
    method,
    path: cleanPath(target),
    status: Number(status),
    bytes: bytes === '-' ? 0 : Number(bytes),
    userAgent: ua,
    clientIp: clientAddress(remoteAddr, forwardedFor),
  };
}
