import { getSiteById } from '../store/read.js';
import { getSearchConsole } from '../auth/google.js';
import { ownDomains } from './lib/site-domain.js';
import { isPrivateOrLocalHost } from './lib/page-content.js';
import {
  classifyHost, isTombstoned, classifyProbe, hasNoindexSignal, groupByHost,
  isHandledByOffsiteRedirect, buildDeadOwnUrlsFinding, buildUnexpectedHostsFinding, buildRedirectActionFinding,
} from './lib/gsc-url-audit.js';
import { pickRedirectTarget } from './lib/redirect-target.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'gsc-url-audit',
  name: 'Indexed URL Audit',
  description: "Checks every URL Google has search data for against what the site actually serves — finds pages that now 404 and hosts indexed in this property that aren't part of the site.",
  category: 'technical',
  version: 1,
};

// See lib/gsc-url-audit.js's header for the blind spot this closes and, more
// importantly, for the invariant that keeps an unfiltered GSC query safe.
// The short version: this is the ONLY consumer that deliberately queries
// Search Console without ingest/gsc.js's own-domain filter, because finding a
// foreign host is the job. Nothing outside the `own` bucket may ever reach a
// generator, and only own-domain dead URLs with a confident live target carry an action (redirect-add, PR for human review); unexpected-host findings never do.

// Long by the standards of this repo's other fetches (page-content.js uses
// 5s), and deliberately so. Doing this by hand first, a 15s timeout against
// one slow host classified 87 live URLs as failures; a 45s retry returned 200
// for every one of them. The cost of being slow here is a longer agent run.
// The cost of being fast is reporting live pages as dead.
const PROBE_TIMEOUT_MS = 45_000;

// Deliberately low. These requests go to the site's own infrastructure, and
// several hosts in a domain property are often one machine behind one reverse
// proxy — the same VPS that serves production. Hammering it to audit it would
// be self-defeating, and the slow-host timeout above only holds if requests
// aren't also queueing behind each other.
const PROBE_CONCURRENCY = 4;

// GSC returns at most 25,000 rows per call; this is well inside that and far
// beyond any real site's indexed-URL count in one property.
const PAGE_ROW_LIMIT = 25_000;
const LOOKBACK_DAYS = 90;

const fmtDate = (d) => d.toISOString().slice(0, 10);

// Search Console only ever returns URLs that received impressions, so this
// is "what Google has search data for", NOT "everything Google has indexed".
// A page indexed but never shown in a result is invisible here, and there is
// no API that exposes the index-coverage report — the only complete source is
// a manual CSV export from the Search Console UI. Worth knowing when this
// agent reports zero dead URLs: that means zero among URLs with impressions.
async function fetchIndexedPages(site) {
  const sc = await getSearchConsole(site);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - LOOKBACK_DAYS);

  const res = await sc.searchanalytics.query({
    siteUrl: site.gsc_property,
    requestBody: {
      startDate: fmtDate(start),
      endDate: fmtDate(end),
      dimensions: ['page'],
      rowLimit: PAGE_ROW_LIMIT,
      // 'all' rather than 'final': fresher data matters more than settled
      // numbers here, because the question is "does this URL exist", not
      // "exactly how many impressions did it get".
      dataState: 'all',
      // NOTE: no dimensionFilterGroups. See the invariant above — this is
      // the one place that omission is correct. Do not "fix" this by adding
      // pageFilterGroups(ownDomains(site)); it would make the
      // unexpected-host half of this agent unable to ever fire.
    },
  });

  return (res.data.rows || []).map((r) => ({
    url: r.keys[0],
    impressions: Number(r.impressions || 0),
    clicks: Number(r.clicks || 0),
  }));
}

// One GET per URL. GET rather than HEAD because some hosts answer HEAD with a
// status they never use for real requests, and because the noindex meta tag
// needs a body. Returns a shape classifyProbe() understands; a thrown fetch
// becomes { status: null }, which classifyProbe treats as `unknown` and never
// as dead.
async function probe(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { url, status: null, error: 'invalid URL' }; }
  // Same SSRF guard every other outbound fetch in this repo uses. It matters
  // more here than anywhere else: these URLs are not operator-configured,
  // they are whatever Search Console returned.
  if (isPrivateOrLocalHost(hostname)) return { url, status: null, error: 'blocked: private/local address' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +gsc-url-audit)' },
    });
    const headers = {};
    for (const [k, v] of res.headers) headers[k.toLowerCase()] = v;
    // Body only when it can carry a signal we actually read. A 404's body is
    // never inspected, so downloading it would be waste.
    const wantsBody = res.ok && (res.headers.get('content-type') || '').includes('html');
    const html = wantsBody ? await res.text() : null;
    return {
      url,
      status: res.status,
      redirected: res.redirected || res.url !== url,
      finalUrl: res.url || url,
      headers,
      html,
    };
  } catch (err) {
    return { url, status: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Bounded-concurrency map. Each worker pulls the next index, so one slow host
// can't stall the others behind a fixed-size batch boundary.
async function probeAll(urls) {
  const out = new Array(urls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++;
        out[i] = await probe(urls[i]);
      }
    })
  );
  return out;
}

export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  if (!site?.gsc_property) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No GSC property connected for this site yet — connect one (via `npm run connect-site`) to enable the indexed-URL audit.',
      generatedAt: new Date().toISOString(),
    };
  }

  const pages = await fetchIndexedPages(site);
  if (!pages.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: `Search Console returned no pages with impressions in the last ${LOOKBACK_DAYS} days — nothing to audit yet. A newly created property can take a few days to backfill.`,
      generatedAt: new Date().toISOString(),
    };
  }

  const domains = ownDomains(site);
  const ignoredHosts = site.seo_ignored_hosts || [];
  const tombstones = site.seo_tombstoned_urls || [];

  const buckets = { own: [], ignored: [], unexpected: [], unparseable: [] };
  for (const page of pages) {
    buckets[classifyHost(page.url, { ownDomains: domains, ignoredHosts })].push(page);
  }

  // Tombstoned URLs are dropped before any probe: a URL somebody has already
  // decided stays a 404 does not need confirming that it is a 404, and the
  // whole point of the record is that it stops being reported.
  const ownToCheck = buckets.own.filter((p) => !isTombstoned(p.url, tombstones));
  const tombstonedSkipped = buckets.own.length - ownToCheck.length;

  // Only one URL per unexpected host is probed, not all of them. The question
  // for a foreign host is "is this whole host already noindexed", which one
  // response answers — and probing 218 URLs on a host that isn't ours to fix
  // would be a lot of traffic for no extra information.
  const unexpectedHosts = groupByHost(buckets.unexpected);
  const [ownProbes, hostProbes] = await Promise.all([
    probeAll(ownToCheck.map((p) => p.url)),
    probeAll(unexpectedHosts.map((h) => h.sampleUrls[0])),
  ]);

  const byUrl = new Map(ownToCheck.map((p, i) => [p.url, { ...p, probe: ownProbes[i] }]));
  const deadUrls = [];
  const liveUrls = [];
  const statusCounts = {};
  for (const entry of byUrl.values()) {
    const verdict = classifyProbe(entry.probe);
    statusCounts[verdict] = (statusCounts[verdict] || 0) + 1;
    if (verdict === 'dead') {
      deadUrls.push({ url: entry.url, impressions: entry.impressions, httpStatus: entry.probe.status });
    } else if (verdict === 'ok' && !hasNoindexSignal(entry.probe)) {
      // Only pages that served 200 and are indexable can be a redirect target.
      liveUrls.push(entry.url);
    }
  }

  // Dead URLs with ONE clearly-right live replacement become reviewable
  // redirect pull requests; the rest stay in the report-only finding below.
  // Capped per run so a site-wide migration cannot open dozens of PRs at once.
  const MAX_REDIRECT_ACTIONS = 15;
  const redirectFindings = [];
  const unmatchedDead = [];
  for (const dead of [...deadUrls].sort((a, b) => b.impressions - a.impressions || a.url.localeCompare(b.url))) {
    const target = redirectFindings.length < MAX_REDIRECT_ACTIONS ? pickRedirectTarget(dead.url, liveUrls) : null;
    if (target) redirectFindings.push(buildRedirectActionFinding({ dead, target }));
    else unmatchedDead.push(dead);
  }

  // A host is already handled two different ways, and both must be excluded:
  // it serves a noindex, or it has been redirected off to another hostname
  // entirely (see isHandledByOffsiteRedirect — a redirect is the better fix of
  // the two, since it moves the ranking signal rather than discarding it).
  // Reporting either one again on every run is how a real signal turns into
  // noise people learn to filter out.
  const handled = unexpectedHosts.map((h, i) => {
    const probe = hostProbes[i] || {};
    if (hasNoindexSignal(probe)) return 'noindex';
    if (isHandledByOffsiteRedirect(probe)) return 'redirected';
    return null;
  });
  const stillIndexable = unexpectedHosts.filter((_, i) => !handled[i]);
  const alreadyNoindexed = handled.filter((h) => h === 'noindex').length;
  const alreadyRedirected = handled.filter((h) => h === 'redirected').length;

  const findings = [
    ...redirectFindings,
    buildDeadOwnUrlsFinding({ deadUrls: unmatchedDead, tombstonedSkipped, checkedCount: ownToCheck.length }),
    buildUnexpectedHostsFinding({ hosts: stillIndexable }),
  ].filter(Boolean);

  const facts = {
    gscProperty: site.gsc_property,
    lookbackDays: LOOKBACK_DAYS,
    totalIndexedUrls: pages.length,
    ownUrls: buckets.own.length,
    ownUrlsChecked: ownToCheck.length,
    tombstonedSkipped,
    ignoredHostUrls: buckets.ignored.length,
    unexpectedHostCount: unexpectedHosts.length,
    unexpectedHostsStillIndexable: stillIndexable.length,
    unexpectedHostsAlreadyNoindexed: alreadyNoindexed,
    unexpectedHostsAlreadyRedirected: alreadyRedirected,
    deadUrlCount: deadUrls.length,
    redirectActionsProposed: redirectFindings.length,
    statusCounts,
    findings,
  };

  if (!findings.length) {
    return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
  }

  const system = 'You are a technical SEO specialist writing for a non-technical site owner. Given real, ' +
    'computed results from checking every URL Google has search data for against what the site actually ' +
    'serves, write 2-3 sentences naming the most important real problem and one concrete next step. ' +
    'Use ONLY the numbers and hostnames given — never invent a URL, host, or count not present in the facts. ' +
    'If unexpected hosts are present, be clear that the fix is a noindex response header and NOT a robots.txt ' +
    'block. Plain text, no markdown, no bullets.';
  const narrative = await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
