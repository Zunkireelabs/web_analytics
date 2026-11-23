import { extractSnapshot, normalizePageUrl } from '../../lib/seo-snapshot.js';
import { compareSnapshots, SEVERITY } from './seo-drift-rules.js';
import { makeFinding, impactFromPriority } from './findings.js';
import { followRedirects } from '../../free-audit/fetchPage.js';
import {
  getBaselines, insertSnapshot, pruneSnapshots, ownChangesSince,
} from '../../store/seo-snapshots.js';

// The nightly drift check for one site: capture each key page, compare it with its baseline, and turn real regressions into
// findings (which the recommendation coordinator shows in the Action Center). See agents/seo-drift.js for the agent wrapper and
// lib/seo-drift-rules.js for what counts as drift.
//
//  - First time a page is seen, its capture IS its baseline; nothing is reported.
//  - A change caused by a fix WE shipped on that page is expected: it is not reported (warnings/info) and the baseline moves
//    forward. A CRITICAL change is always reported even then, because a fix of ours that removed the page's schema, or added
//    noindex, is exactly the kind of mistake this exists to catch.
//  - A page that cannot be reached at all (timeout, DNS, blocked) is "unverifiable": skipped, never flagged, never snapshotted.
//  - Info-level changes are kept in the history and never reported.

export const MAX_PAGES = 25;
const CONCURRENCY = 4;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// Fetches one page the way a crawler would (redirects followed, every hop checked against private/internal addresses) and
// extracts its snapshot. Never throws: an unreachable page returns { ok: false }.
export async function capturePage(url, { follow = followRedirects } = {}) {
  try {
    const { res, finalUrl } = await follow(new URL(url));
    const type = res.headers.get('content-type') || '';
    let html = null;
    if (/text\/html|application\/xhtml\+xml/i.test(type)) html = (await res.text()).slice(0, MAX_BODY_BYTES);
    else await res.body?.cancel?.().catch?.(() => {});
    return { ok: true, snap: extractSnapshot({ html, statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), pageUrl: finalUrl.toString() }) };
  } catch (err) {
    return { ok: false, error: err?.code || err?.name || 'fetch_failed' };
  }
}

// The pages worth watching: the site's most-seen pages (Search Console), plus the home page, de-duplicated, capped.
export function pickPages({ site, topPages = [], max = MAX_PAGES }) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    let key; try { key = normalizePageUrl(raw); } catch { return; }
    if (!/^https?:/i.test(key) || seen.has(key)) return;
    seen.add(key); out.push(key);
  };
  const domain = String(site?.website_domain || '').trim();
  if (domain) { try { add(`${new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin}/`); } catch { /* not a URL: no home page to add */ } }
  for (const p of topPages) add(p);
  return out.slice(0, max);
}

// A fix of ours went live on this page after its baseline was taken. The draft records the page as a full URL or a path.
export function changedByUs(url, baselineAt, own) {
  if (!own?.size) return false;
  const u = new URL(url);
  const forms = new Set([url, u.pathname + u.search, u.pathname, u.pathname.replace(/\/$/, ''), `${u.origin}${u.pathname.replace(/\/$/, '')}`].map((x) => x.toLowerCase()));
  for (const form of forms) {
    const at = own.get(form);
    if (at && at > new Date(baselineAt)) return true;
  }
  return false;
}

const clip = (v, n = 90) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

export function buildFinding({ url, baseline, changes, impressions = 0 }) {
  const critical = changes.some((c) => c.severity === SEVERITY.CRITICAL);
  const priority = critical ? 'high' : 'medium';
  const lines = changes.slice(0, 4).map((c) => (c.was && c.now ? `${c.what}: was "${clip(c.was)}", now "${clip(c.now)}"` : c.message));
  return makeFinding({
    id: `seo-drift:page:${url}`,
    evidence: { page: url, baselineAt: baseline.capturedAt, changes: changes.map(({ rule, severity, what, was, now }) => ({ rule, severity, what, was, now })) },
    whyItMatters: `${pathOf(url)} has changed since ${dayOf(baseline.capturedAt)}: ${lines.join('; ')}. ${critical ? 'This kind of change can cost the page its place in search.' : 'Worth a look, in case it was not intended.'}`,
    priority,
    recommendedAction: null,
    reportOnly: {
      kind: 'seo-drift',
      label: critical ? 'Important change to a live page' : 'Change to a live page',
      page: url,
      whyBlocked: 'This is a change to the live page that nothing here made. There is no automatic fix, because the right answer is either to undo it or to accept it. If it was intended, mark it as intended and it will stop being reported.',
    },
    expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: impressions },
  });
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

/**
 * @returns { pagesChecked, firstCaptures, unverifiable, suppressedOwnChanges, findings, checkedPages, history }
 *   history = every difference found, info included, for the run's record.
 */
export async function runDrift({ siteId, pages, impressionsByPage = new Map(), deps = {} }) {
  const d = { capture: capturePage, getBaselines, insertSnapshot, pruneSnapshots, ownChangesSince, ...deps };
  const baselines = await d.getBaselines(siteId, pages);
  const captures = await inBatches(pages, CONCURRENCY, async (url) => ({ url, cap: await d.capture(url) }));

  // Our own fixes since the oldest baseline that actually shows a difference: one read for the whole run.
  const compared = captures.map(({ url, cap }) => {
    const baseline = baselines.get(url);
    if (!cap.ok || !baseline) return { url, cap, baseline, changes: [] };
    let changes = compareSnapshots(baseline, cap.snap);
    // A page that now errors shows its error page's title and headings; those are not "changes", the error is the one finding.
    if (cap.snap.statusCode >= 400) changes = changes.filter((c) => c.rule === 'page-error');
    return { url, cap, baseline, changes };
  });
  const needOwn = compared.filter((c) => c.changes.some((x) => x.severity !== SEVERITY.INFO));
  const own = needOwn.length ? await d.ownChangesSince(siteId, new Date(Math.min(...needOwn.map((c) => new Date(c.baseline.capturedAt).getTime())))) : new Map();

  const result = { pagesChecked: 0, firstCaptures: 0, unverifiable: 0, suppressedOwnChanges: 0, findings: [], checkedPages: [], history: [] };
  for (const { url, cap, baseline, changes } of compared) {
    if (!cap.ok) { result.unverifiable += 1; continue; }
    result.pagesChecked += 1;
    result.checkedPages.push(url);

    if (!baseline) {
      await d.insertSnapshot(siteId, url, cap.snap, { baselineReason: 'first-capture' });
      result.firstCaptures += 1;
      continue;
    }
    if (changes.length) result.history.push({ page: url, changes: changes.map(({ rule, severity }) => ({ rule, severity })) });

    let report = changes.filter((c) => c.severity !== SEVERITY.INFO);
    let promote = false;
    if (report.length && changedByUs(url, baseline.capturedAt, own)) {
      const critical = report.filter((c) => c.severity === SEVERITY.CRITICAL);
      if (critical.length !== report.length) result.suppressedOwnChanges += 1;
      report = critical;
      promote = critical.length === 0; // nothing alarming left: the page as our fix left it is the new normal
    }
    if (report.length) result.findings.push(buildFinding({ url, baseline, changes: report, impressions: impressionsByPage.get(url) || 0 }));

    await d.insertSnapshot(siteId, url, cap.snap, promote ? { baselineReason: 'own-change' } : {});
    await d.pruneSnapshots(siteId, url);
  }
  return result;
}
