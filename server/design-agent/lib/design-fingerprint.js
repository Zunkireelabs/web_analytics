import { createHash } from 'node:crypto';

// A cheap stand-in for "has this site's design changed?": a hash of the
// stylesheets its homepage loads. No browser and no LLM — two HTTP fetches per
// file — so it can run weekly for every site while the full capture stays
// monthly. A redesign changes the CSS (or its content-hashed filename), so the
// hash moves; an unrelated content edit does not.

const MAX_FILES = 6;
const MAX_BYTES = 600 * 1024;
const TIMEOUT_MS = 10_000;

export function extractStylesheetUrls(html, baseUrl) {
  const out = [];
  const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const m = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!m) continue;
    try { out.push(new URL(m[1], baseUrl).toString()); } catch { /* skip a malformed href */ }
  }
  return [...new Set(out)].slice(0, MAX_FILES);
}

export function fingerprintOf(parts) {
  const h = createHash('sha1');
  for (const p of [...parts].sort()) h.update(p).update('\n');
  return h.digest('hex');
}

async function getText(fetchFn, url) {
  const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, MAX_BYTES);
}

// Returns a hex fingerprint, or null when the site could not be read — callers
// must treat null as "no information", never as "changed".
export async function computeDesignFingerprint(pageUrl, { fetchFn = fetch } = {}) {
  try {
    const html = await getText(fetchFn, pageUrl);
    const sheets = extractStylesheetUrls(html, pageUrl);
    if (!sheets.length) return null;
    const parts = [];
    for (const url of sheets) {
      const css = await getText(fetchFn, url);
      parts.push(`${new URL(url).pathname}:${createHash('sha1').update(css).digest('hex')}`);
    }
    return fingerprintOf(parts);
  } catch {
    return null;
  }
}
