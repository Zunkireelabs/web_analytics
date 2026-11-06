import { canonicalizePage } from './canonical.js';

// Do two URLs that differ only by a trailing slash, the scheme or www serve ONE page? The canonical key may merge them only when
// the site itself says so, by one of two kinds of evidence:
//
//   redirect   fetching one lands on the other (a 301/302/307/308 chain), or both land on the same final URL
//   canonical  the pages' own <link rel="canonical"> names the other URL, or both name the same URL
//
// Anything else (both answer separately with no canonical tying them, an error, a page that is not HTML) is NOT evidence, and the
// two stay separate. Path case and meaningful query parameters are never part of this test: they are kept by canonicalizePage.
//
// `fetchPage(url)` is injected: in production it is the free audit's fetchMainPage, which guards every hop against private
// addresses. It must resolve { html, finalUrl, statusCode } or throw.

const CANONICAL_TAG = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i;
const HREF = /\bhref\s*=\s*["']([^"']+)["']/i;

export function canonicalTagOf(html, baseUrl) {
  const tag = CANONICAL_TAG.exec(String(html || ''))?.[0];
  const href = tag ? HREF.exec(tag)?.[1] : null;
  if (!href) return null;
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

// the comparison form: the always-safe rules only (no slash, scheme or www merging, which is the very thing being tested)
const same = (a, b) => a != null && b != null && canonicalizePage(String(a)).key === canonicalizePage(String(b)).key;

export async function establishEquivalence(urlA, urlB, { fetchPage }) {
  const evidence = { a: urlA, b: urlB };
  let ra; let rb;
  try { ra = await fetchPage(urlA); } catch (err) { evidence.errorA = err.message; }
  try { rb = await fetchPage(urlB); } catch (err) { evidence.errorB = err.message; }
  const finalA = ra?.finalUrl ? String(ra.finalUrl) : null;
  const finalB = rb?.finalUrl ? String(rb.finalUrl) : null;
  Object.assign(evidence, { finalA, finalB });

  if (ra && rb && same(finalA, finalB)) return { equivalent: true, basis: 'redirect', detail: 'both land on the same final URL', evidence };
  if (ra && same(finalA, urlB)) return { equivalent: true, basis: 'redirect', detail: `${urlA} redirects to ${urlB}`, evidence };
  if (rb && same(finalB, urlA)) return { equivalent: true, basis: 'redirect', detail: `${urlB} redirects to ${urlA}`, evidence };

  const canonA = ra ? canonicalTagOf(ra.html, finalA) : null;
  const canonB = rb ? canonicalTagOf(rb.html, finalB) : null;
  Object.assign(evidence, { canonicalA: canonA, canonicalB: canonB });
  if (canonA && canonB && same(canonA, canonB)) return { equivalent: true, basis: 'canonical', detail: 'both pages name the same canonical URL', evidence };
  if (canonA && same(canonA, urlB)) return { equivalent: true, basis: 'canonical', detail: `${urlA} names ${urlB} as canonical`, evidence };
  if (canonB && same(canonB, urlA)) return { equivalent: true, basis: 'canonical', detail: `${urlB} names ${urlA} as canonical`, evidence };

  const reason = !ra || !rb ? 'one of them could not be fetched' : 'both answer separately and no canonical ties them';
  return { equivalent: false, basis: null, detail: reason, evidence };
}
