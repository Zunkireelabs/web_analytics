import { fetchResponseHeaders } from './lib/page-content.js';
import { getSearchPerformanceForPages } from '../store/read.js';
import { aggregateSystemicFinding } from './lib/findings.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'security-headers',
  name: 'Security Headers Agent',
  description: 'Checks real HTTP response headers (HSTS, Content-Security-Policy, X-Content-Type-Options, clickjacking protection, Referrer-Policy) across the site\'s own pages.',
  category: 'security',
  version: 1,
  // No external data source — every signal here is read directly off the
  // real HTTP response headers this site's own server already sends, same
  // self-sufficiency as e.g. opportunity.js/query-intelligence.js.
};

const MAX_PAGES = 20;

// Each header's real security purpose, and how "present" is decided — a
// couple of these have a legitimate modern equivalent that isn't the header
// itself (e.g. CSP's frame-ancestors directive supersedes X-Frame-Options),
// so "missing" only fires when neither the header nor its real equivalent
// is present, not just a literal header-name lookup.
const CHECKS = [
  {
    key: 'strict-transport-security',
    label: 'HSTS (Strict-Transport-Security)',
    detail: 'forces browsers to only ever connect over HTTPS, even if a user types or is linked to an http:// URL',
  },
  {
    key: 'content-security-policy',
    label: 'Content-Security-Policy',
    detail: 'restricts which scripts/resources a page is allowed to load, a real mitigation against XSS and data-injection attacks',
  },
  {
    key: 'x-content-type-options',
    label: 'X-Content-Type-Options',
    detail: 'stops browsers from guessing (\'sniffing\') a file\'s type in a way that can turn an uploaded file into executable script',
  },
  {
    key: 'x-frame-options',
    label: 'X-Frame-Options / CSP frame-ancestors',
    detail: 'prevents this page from being embedded in a hidden frame on another site (clickjacking)',
    satisfiedBy: (headers) => (headers.get('content-security-policy') || '').toLowerCase().includes('frame-ancestors'),
  },
  {
    key: 'referrer-policy',
    label: 'Referrer-Policy',
    detail: 'controls how much of this site\'s own URL structure leaks to other sites via the Referer header when a user clicks an outbound link',
  },
];

export async function run({ siteId, start, end, params }) {
  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    : await selectCandidatePages(siteId, 'security-headers', { start, end, batchSize: MAX_PAGES });

  if (!batch.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No page performance data yet to select pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const fetched = await Promise.all(batch.map(async (page) => ({ page, result: await fetchResponseHeaders(page) })));
  if (!params?.pages?.length) await markPagesChecked(siteId, 'security-headers', batch);

  const reachable = fetched.filter((r) => r.result.ok);

  // Response headers are set once at the server/CDN/middleware level, not
  // per route — a header missing on one page is missing on virtually every
  // page, so each header is one aggregated finding (how many of the real
  // checked pages lack it), not N near-identical per-page findings for the
  // same root config gap.
  const findings = CHECKS.flatMap((check) => {
    const missing = reachable.filter((r) => {
      const present = r.result.headers.has(check.key);
      return !present && !(check.satisfiedBy?.(r.result.headers));
    });
    const finding = aggregateSystemicFinding({
      id: `security-headers:${check.key}`,
      affected: missing,
      checkedCount: reachable.length,
      getPage: (r) => r.page,
      getImpressions: (r) => impressionsByPage.get(r.page) || 0,
      whyItMatters: (n, c) => `${check.label} is missing on ${n} of ${c} checked pages — it ${check.detail}.`,
      recommendedAction: null, // a response-header fix is a server/CDN config change, not draftable content
    });
    return finding ? [finding] : [];
  });

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    pagesChecked: fetched.map((r) => ({ page: r.page, ok: r.result.ok, error: r.result.ok ? null : r.result.error })),
    findings,
  };

  const system = 'You are a web security specialist writing for a non-technical site owner. Given real, missing ' +
    'HTTP security headers found across this site\'s own pages, write 2-3 sentences naming the single most ' +
    'important missing header and one concrete next step (usually a server/CDN configuration change, not content). ' +
    'Use ONLY the data given, never invent a header or page not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] security-headers narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
