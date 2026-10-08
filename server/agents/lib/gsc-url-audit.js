import { makeFinding } from './findings.js';

// Pure helpers for the GSC URL audit (server/agents/gsc-url-audit.js) — same
// "DB/HTTP stays in the agent, real logic lives in a testable lib" split as
// sitemap-diff.js and technical-seo-analysis.js.
//
// THE BLIND SPOT THIS CLOSES
//
// Two existing agents look like they would already catch a dead or
// unexpected indexed URL, and neither can:
//   - sitemap.js finds URLs MISSING FROM the sitemap. The inverse — a URL
//     Google knows about that the site no longer serves — is not a sitemap
//     diff at all, because a deleted page is absent from the sitemap by
//     design and so reads as correct.
//   - technical-seo.js finds broken links by following the site's own
//     internal links. A URL reachable only from Google's index (an old page,
//     a foreign subdomain) has no inbound internal link, so there is nothing
//     for it to follow.
// So URLs accumulate in Google's index unobserved — which is how 262 URLs
// across six unrelated subdomains ended up in one property's reports with
// nobody noticing.
//
// WHY THIS DELIBERATELY BYPASSES THE OWN-DOMAIN FILTER
//
// ingest/gsc.js filters at the Search Console API request itself so that no
// agent can ever see a foreign subdomain's data (pageFilterGroups). That is
// right for every consumer whose job is the site's own pages — and fatal
// here, because finding an unexpected host IS this audit's job. On the
// filtered path it would be structurally incapable of ever reporting one.
//
// So this audit queries unfiltered, and containment moves from "cannot see
// it" to "can see it, must never act on it". Two rules enforce that, and
// both must survive any future edit:
//   1. classifyHost puts every URL in exactly one bucket, and nothing
//      outside the `own` bucket may ever reach a generator's params.
//   2. Neither finding here carries a recommendedAction at all. They are
//      report-only rows (findings.js's ReportOnly), so there is no draft
//      path, no PR, and no way for a foreign URL to become a code change.
// These are the only things standing between this audit and the exact
// cross-tenant leak the ingest filter exists to prevent.

// Hostname + path, trailing slash and leading www removed, query dropped.
// Same normalisation philosophy as sitemap-diff.js's normalizeForCompare: a
// trailing-slash or www difference is never a different page, and anything
// that is not a parseable absolute URL falls back to the raw string rather
// than throwing, so one malformed GSC row cannot abort a whole run.
export function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}`;
  } catch {
    return String(url ?? '').trim().toLowerCase();
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Exactly one bucket per URL.
//
// ownDomains is matched on EQUALITY, never suffix: a suffix match would
// treat every subdomain of the root domain as the site's own, which is
// precisely the mistake that let unrelated projects into this site's reports
// to begin with. A site that genuinely owns a subdomain lists it explicitly
// in additional_own_domains (migration 123).
export function classifyHost(url, { ownDomains, ignoredHosts } = {}) {
  const host = hostOf(url);
  if (!host) return 'unparseable';

  const normalize = (d) => String(d).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const own = (ownDomains || []).filter(Boolean).map(normalize);

  // No own-domain configured yet: same "pass through unfiltered" convention
  // as knownDomain()/filterOwnDomainPages. Treating every URL as foreign
  // here would report a site's entire index as unexpected on its first run.
  if (!own.length) return 'own';
  if (own.includes(host)) return 'own';

  const ignored = (ignoredHosts || []).filter(Boolean).map(normalize);
  if (ignored.includes(host)) return 'ignored';

  return 'unexpected';
}

export function isTombstoned(url, tombstonedUrls) {
  if (!tombstonedUrls?.length) return false;
  const key = normalizeUrlKey(url);
  return tombstonedUrls.some((t) => normalizeUrlKey(t) === key);
}

// Buckets one HTTP probe result. Deliberately conservative about what counts
// as dead, because a false positive here is not cosmetic: a URL wrongly
// called dead becomes a reported defect against a page that is actually
// live, and a human then "fixes" something that was never broken.
//
// Learned concretely while doing this by hand before generalising it: a 15s
// timeout against one slow host produced 87 "errors" that a 45s retry showed
// were all 200 OK. A timeout, a connection reset and a 5xx are therefore
// `unknown`, never `dead` — absence of an answer is not evidence of absence.
// Only an explicit 404/410 from the server is `dead`.
export function classifyProbe(probe) {
  if (!probe) return 'unknown';
  if (probe.status === 404 || probe.status === 410) return 'dead';
  if (probe.status == null) return 'unknown'; // timeout, DNS failure, reset
  if (probe.status >= 500) return 'unknown'; // server having a bad day, not a deleted page
  if (probe.status >= 400) return 'blocked'; // 401/403 — exists, gated
  if (probe.redirected) return 'redirect';
  return 'ok';
}

// Does this response already tell Google to stay out? Checked on BOTH the
// header and the meta tag, because the fix is legitimately applied at either
// layer — a reverse-proxy middleware emits the header (no application change
// needed), a framework emits the meta tag. Checking only one would re-report
// a host that is already correctly handled, and an alert nobody can clear is
// an alert everybody learns to ignore.
export function hasNoindexSignal({ headers, html } = {}) {
  const header = headers?.['x-robots-tag'] ?? headers?.['X-Robots-Tag'] ?? '';
  if (/noindex/i.test(String(header))) return true;
  if (!html) return false;
  return (String(html).match(/<meta[^>]+>/gi) || [])
    .some((tag) => /name=["']?robots["']?/i.test(tag) && /noindex/i.test(tag));
}

// Has this host already been dealt with by moving its content somewhere else?
//
// A host that permanently redirects to a DIFFERENT hostname no longer serves
// anything, so there is nothing left to de-index: Google follows the redirect
// and consolidates the old URL into the target. That is a better outcome than
// noindex — noindex throws the accumulated ranking signal away, a redirect
// transfers it — so a redirected host must not be reported as a problem.
//
// Found by dry-running this agent against real data: zenly.<domain> 308s to
// the product's own domain, which is exactly the right fix, and the first
// version of this file flagged it anyway because it only ever looked for a
// noindex signal. Left unfixed it would have nagged about a correctly handled
// host on every single run.
//
// Compared on the full hostname rather than the registrable domain, so a
// redirect to the site's own main host counts as handled too (also a
// consolidation, also correct). A redirect that lands back on the same
// hostname is just an internal path change and is NOT handled.
export function isHandledByOffsiteRedirect(probe) {
  if (!probe?.redirected || !probe.finalUrl) return false;
  const from = hostOf(probe.url);
  const to = hostOf(probe.finalUrl);
  return Boolean(from && to && from !== to);
}

// Groups classified rows into the per-host shape the unexpected-hosts finding
// expects, so the agent stays a thin fetch-and-call.
export function groupByHost(rows) {
  const byHost = new Map();
  for (const row of rows) {
    const host = hostOf(row.url);
    if (!host) continue;
    const entry = byHost.get(host) || { host, urlCount: 0, impressions: 0, sampleUrls: [] };
    entry.urlCount += 1;
    entry.impressions += row.impressions || 0;
    if (entry.sampleUrls.length < 5) entry.sampleUrls.push(row.url);
    byHost.set(host, entry);
  }
  return [...byHost.values()].sort((a, b) => b.impressions - a.impressions || a.host.localeCompare(b.host));
}

// --- findings ---------------------------------------------------------------

// Dead URLs on the site's OWN domain.
//
// Report-only, and NOT because of the foreign-URL invariant above — these are
// genuinely the site's own pages. It is report-only because the correct fix
// is not observable from outside the site. A deliberately retired page and an
// accidentally deleted one are byte-for-byte identical over HTTP: same 404,
// same inbound links, same decaying impressions. Recreating the page
// (missing-page-create) is right for the accident and actively wrong for the
// retirement, and guessing wrong means this platform resurrects a page
// somebody removed on purpose, then does it again after every manual revert.
//
// Recording that decision is what sites.seo_tombstoned_urls is for: once a
// URL is tombstoned the caller filters it out here, and it stops being
// reported at all.
export function buildDeadOwnUrlsFinding({ deadUrls, tombstonedSkipped = 0, checkedCount }) {
  if (!deadUrls?.length) return null;
  const byImpressionsDesc = [...deadUrls].sort(
    (a, b) => (b.impressions || 0) - (a.impressions || 0) || a.url.localeCompare(b.url)
  );
  const totalImpressions = byImpressionsDesc.reduce((s, u) => s + (u.impressions || 0), 0);
  const n = byImpressionsDesc.length;

  return makeFinding({
    // Keyed on the normalised URL set, not the count: a different set of dead
    // URLs is a different finding, while a re-run over the same set reuses
    // this id and dedups, same reasoning as sitemap-diff.js's fingerprintSet.
    id: `gsc-url-audit:dead-own-urls:${byImpressionsDesc.map((u) => normalizeUrlKey(u.url)).sort().join('|')}`,
    evidence: {
      deadUrls: byImpressionsDesc.map((u) => ({ url: u.url, impressions: u.impressions || 0, httpStatus: u.httpStatus ?? null })),
      deadCount: n,
      totalImpressions,
      checkedCount,
      tombstonedSkipped,
    },
    whyItMatters:
      `${n} URL${n === 1 ? '' : 's'} on this site still appear${n === 1 ? 's' : ''} in Google Search but now ` +
      `return 404, accounting for ${totalImpressions} impression${totalImpressions === 1 ? '' : 's'}. ` +
      `Each one is a live search result that sends visitors to an error page.` +
      (tombstonedSkipped
        ? ` A further ${tombstonedSkipped} 404${tombstonedSkipped === 1 ? '' : 's'} ${tombstonedSkipped === 1 ? 'was' : 'were'} ignored as intentionally deleted.`
        : ''),
    priority: totalImpressions > 0 ? 'high' : 'medium',
    recommendedAction: null,
    reportOnly: {
      kind: 'dead-indexed-url',
      label: 'Indexed URL now returns 404',
      page: byImpressionsDesc[0].url,
      whyBlocked:
        'Whether this page should come back or stay gone is not something that can be read off the site: a ' +
        'deliberately retired page and an accidentally deleted one return the same 404. Decide per URL — ' +
        'restore it, redirect it to its replacement, or leave it as a 404 and record it as intentionally ' +
        'deleted so it stops being reported.',
    },
    expectedImpact: { label: totalImpressions > 0 ? 'Medium' : 'Low', basis: 'computed', value: totalImpressions },
  });
}

// Unexpected hosts: URLs Google has indexed on a host that is neither the
// site's own nor recorded as deliberately ignored.
//
// Always report-only, per rule 2 of the invariant at the top of this file.
// Two further reasons it could not be actionable even without that rule: the
// fix is a reverse-proxy, DNS or hosting change that lives outside any repo
// this platform can open a pull request against, and the host may belong to
// an entirely different party.
//
// Hosts already serving a noindex are filtered out by the caller — they are
// handled, and re-reporting them forever is how a signal becomes noise.
export function buildUnexpectedHostsFinding({ hosts }) {
  if (!hosts?.length) return null;
  const ordered = [...hosts].sort((a, b) => (b.impressions || 0) - (a.impressions || 0) || a.host.localeCompare(b.host));
  const totalUrls = ordered.reduce((s, h) => s + h.urlCount, 0);
  const hostCount = ordered.length;

  return makeFinding({
    id: `gsc-url-audit:unexpected-hosts:${ordered.map((h) => h.host).sort().join(',')}`,
    evidence: {
      hosts: ordered.map((h) => ({
        host: h.host,
        urlCount: h.urlCount,
        impressions: h.impressions || 0,
        sampleUrls: h.sampleUrls.slice(0, 5),
      })),
      hostCount,
      totalUrls,
    },
    whyItMatters:
      `Google has indexed ${totalUrls} URL${totalUrls === 1 ? '' : 's'} across ${hostCount} ` +
      `host${hostCount === 1 ? '' : 's'} that ${hostCount === 1 ? 'is' : 'are'} not part of this site and ` +
      `${hostCount === 1 ? 'has' : 'have'} not been excluded. A staging or admin host indexed alongside the ` +
      'real site competes with it for the same queries and distorts every number in this property.',
    priority: 'medium',
    recommendedAction: null,
    reportOnly: {
      kind: 'unexpected-indexed-host',
      label: 'Unexpected host indexed in this property',
      page: ordered[0].sampleUrls[0] || `https://${ordered[0].host}/`,
      whyBlocked:
        'Fixing this means a reverse-proxy, DNS or hosting change outside any repository this platform can ' +
        'open a pull request against, and the host may belong to a different party. Review each host: if it ' +
        'should stay out of Google, serve it an "X-Robots-Tag: noindex" response header and record it as an ' +
        'ignored host. Do not block it in robots.txt instead — Google has to be able to crawl a page to see ' +
        'its noindex, so blocking the crawl freezes it in the index rather than removing it.',
    },
    expectedImpact: { label: 'Medium', basis: 'computed', value: totalUrls },
  });
}
