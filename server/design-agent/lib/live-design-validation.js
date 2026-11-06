// LIVE DESIGN VALIDATION — before the agent edits a page, check that the design
// it is about to follow is the page's CURRENT design, not a stale capture.
//
// Background. The design capture is a snapshot. A site changes: a post is
// rebuilt on a different template, a new page appears, a section is redesigned.
// The layout survey (live-analysis/layout-survey.js) groups every known page by
// real structure and saves that map on the design profile (profile.layoutGroups),
// with one captured sample per group in profile.pages. That is accurate on the
// day it was taken and silently wrong afterwards.
//
// What this does, per page, per edit:
//   1. fetch the page's CURRENT served HTML and reduce it to a LAYOUT fingerprint
//      (structure only — see computeLayoutFingerprint);
//   2. compare it with its assigned group's sample (also read live);
//   3. matches            -> use the group's captured design (after checking the
//                            captured data itself still describes the live sample);
//      clearly different  -> capture THIS page on its own, and say how the group
//                            map should change;
//      no group yet       -> look for an existing group it matches, else capture
//                            it before anything is edited;
//      uncertain / failed -> never fall back to a stale design: block the edit
//                            (or, where a fresh capture of this very page
//                            succeeded, use that provisional capture and flag it).
//
// Content vs layout. A blog post with more paragraphs, another image or a longer
// list is the same design. The fingerprint therefore ignores content-level
// elements (paragraphs, headings, list items, links, images, table cells…) and
// text entirely, and looks only at the classes of the structural containers
// near the top of the page. Content-only changes cannot move the fingerprint,
// so they never create a group.
//
// Nothing here writes anywhere. validatePageDesign returns a DESIGN CONTEXT (the
// one object the page-template builder and the composer both read) and an
// optional UPDATE describing how the saved profile should change; persisting is
// the caller's decision. applyDesignUpdate is the pure function that shows what
// the profile would look like afterwards.
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { layoutGroupFor } from './layout-groups.js';
import { scopedDesignContextFor } from './design-context-scope.js';

export const FINGERPRINT_VERSION = 2;
export const DESIGN_CONTEXT_VERSION = 2;

// Layout comparison combines THREE signals, because no single one separates
// "same template, different content" from "same design system, different
// template":
//   similarity   Jaccard over the structural class sets
//   containment  how much of EACH page's classes the other explains
//                (a page with extra sections is not contained by a leaner sample)
//   skeleton     ordered similarity of the page's top-level section structure
//                (same classes in a different arrangement is a different layout)
// A match needs all three. A clear miss on similarity or skeleton is "different".
// Everything between is "uncertain" — kept as its own outcome, never rounded
// into a match. Calibrated on real pages of the three live sites (see the
// Phase 1 audit); override with the env vars only for experiments.
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
export const MATCH_AT = num(process.env.LIVE_DESIGN_MATCH_AT, 0.8);
export const MATCH_CONTAINMENT = num(process.env.LIVE_DESIGN_MATCH_CONTAINMENT, 0.85);
export const MATCH_SKELETON = num(process.env.LIVE_DESIGN_MATCH_SKELETON, 0.75);
export const DIFFERENT_BELOW = num(process.env.LIVE_DESIGN_DIFFERENT_BELOW, 0.5);
export const DIFFERENT_SKELETON_BELOW = num(process.env.LIVE_DESIGN_DIFFERENT_SKELETON_BELOW, 0.4);
// Share of a capture's recorded classes that must still exist on the live page
// for the capture to count as current.
export const MIN_CAPTURE_COVERAGE = num(process.env.LIVE_DESIGN_MIN_COVERAGE, 0.9);
// No structural nodes, or a single classless wrapper: nothing to compare (client-rendered shell).
export const isUnreadableFingerprint = (fp) => !fp || (fp.skeleton?.length || 0) < 2 && (fp.count || 0) < 2;
const MAX_DEPTH = 4;

// Elements that hold CONTENT. Their classes (and text) never decide layout.
const CONTENT_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'a', 'span', 'strong', 'em', 'b', 'i', 'u', 'small', 'mark',
  'img', 'picture', 'source', 'svg', 'path', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th', 'caption', 'br', 'hr', 'figcaption', 'time', 'label', 'input', 'textarea', 'select',
  'option', 'button', 'dt', 'dd', 'sup', 'sub', 'cite', 'abbr', 'video', 'audio', 'iframe', 'ul', 'ol', 'dl', 'figure',
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head']);

const classTokens = (value) => String(value || '').split(/\s+/).filter(Boolean);
const short = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

// ── Fingerprint ────────────────────────────────────────────────────────────

export function computeLayoutFingerprint(html) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, template').remove();
  let root = $('main').first();
  if (!root.length) {
    $('body > header, body > footer, body > nav, [role="banner"], [role="contentinfo"]').remove();
    root = $('body').first();
  }
  const classes = new Set();
  const skeleton = [];
  let sectionCount = 0;

  const walk = (el, depth) => {
    $(el).children().each((_, child) => {
      const tag = String(child.tagName || '').toLowerCase();
      if (!tag || SKIP_TAGS.has(tag) || CONTENT_TAGS.has(tag)) return;
      const cls = classTokens($(child).attr('class'));
      for (const c of cls) classes.add(c);
      // Document-order descriptor of every structural node in the top two
      // levels; compared as a sequence, so the ARRANGEMENT of sections counts.
      if (depth <= 2) skeleton.push(short(`${depth}:${tag}:${[...cls].sort().join('.')}`));
      if (depth === 1 && (tag === 'section' || tag === 'article')) sectionCount++;
      if (depth < MAX_DEPTH) walk(child, depth + 1);
    });
  };
  walk(root, 1);

  const sorted = [...classes].sort();
  return {
    version: FINGERPRINT_VERSION,
    classes: sorted,
    count: sorted.length,
    sectionCount,
    skeleton,
    hash: createHash('sha1').update(sorted.join(' ')).digest('hex').slice(0, 16),
    skeletonHash: createHash('sha1').update(skeleton.join('|')).digest('hex').slice(0, 16),
  };
}

function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

export function compareLayouts(page, sample) {
  if (!page || !sample) return { similarity: 0, containment: { page: 0, sample: 0, min: 0 }, skeleton: 0, verdict: 'unknown' };
  const A = new Set(page.classes || []);
  const B = new Set(sample.classes || []);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const similarity = inter / ((A.size + B.size - inter) || 1);
  const cPage = A.size ? inter / A.size : 0;     // how much of the PAGE the sample explains
  const cSample = B.size ? inter / B.size : 0;   // how much of the SAMPLE the page has
  const sa = page.skeleton || []; const sb = sample.skeleton || [];
  const skeleton = sa.length || sb.length ? lcsLength(sa, sb) / Math.max(sa.length, sb.length) : 1;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const containment = { page: r3(cPage), sample: r3(cSample), min: r3(Math.min(cPage, cSample)) };
  let verdict;
  if (similarity >= MATCH_AT && containment.min >= MATCH_CONTAINMENT && skeleton >= MATCH_SKELETON) verdict = 'match';
  else if (similarity < DIFFERENT_BELOW || skeleton < DIFFERENT_SKELETON_BELOW) verdict = 'different';
  else verdict = 'uncertain';
  return { similarity: r3(similarity), containment, skeleton: r3(skeleton), verdict };
}

// All class tokens on a page (any element) — the live vocabulary.
export function liveClassSet(html) {
  const $ = cheerio.load(String(html || ''));
  const out = new Set();
  $('[class]').each((_, el) => { for (const c of classTokens($(el).attr('class'))) out.add(c); });
  return out;
}

// Every class string recorded anywhere inside a capture's sections.
export function capturedClasses(sections) {
  const out = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'classes' || k === 'className' || k === 'class') && typeof v === 'string') classTokens(v).forEach((c) => out.add(c));
      else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(sections);
  return out;
}

// Does the captured data still describe the live page? (share of captured
// classes that still exist on it). A capture with nothing to check is
// "unverifiable", never "current".
export function captureCoverage(sections, liveHtml) {
  const captured = capturedClasses(sections);
  if (!captured.size) return { checked: 0, coverage: null };
  const live = liveClassSet(liveHtml);
  let present = 0;
  for (const c of captured) if (live.has(c)) present++;
  return { checked: captured.size, coverage: Math.round((present / captured.size) * 1000) / 1000 };
}

export const pathKey = (url) => {
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    return (u.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '') || '/') + u.search;
  } catch { return null; }
};

// ── Bounded I/O: limiter, cache, de-duplication, deadline ──────────────────

export function createLimiter(max) {
  let active = 0; const queue = [];
  const next = () => { if (active < max && queue.length) { active++; const { fn, res, rej } = queue.shift(); fn().then(res, rej).finally(() => { active--; next(); }); } };
  return (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

// Caches the PROMISE, so concurrent callers for one URL share one request; failures are
// not cached (a transient error must not poison later attempts).
export function createFetchCache({ ttlMs = 5 * 60_000, maxEntries = 500, now = () => Date.now() } = {}) {
  const map = new Map();
  return async function cached(key, loader) {
    const hit = map.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
    const promise = loader();
    map.set(key, { at: now(), promise });
    promise.catch(() => { if (map.get(key)?.promise === promise) map.delete(key); });
    if (map.size > maxEntries) map.delete(map.keys().next().value);
    return promise;
  };
}

const inflightCaptures = new Map(); // key -> promise : concurrent drafts for one page share ONE capture
export function captureOnce(key, loader) {
  if (inflightCaptures.has(key)) return inflightCaptures.get(key);
  const p = loader().finally(() => inflightCaptures.delete(key));
  inflightCaptures.set(key, p);
  return p;
}

const FETCH_TIMEOUT_MS = num(process.env.LIVE_DESIGN_FETCH_TIMEOUT_MS, 10_000);
const OVERALL_DEADLINE_MS = num(process.env.LIVE_DESIGN_DEADLINE_MS, 120_000); // includes 3-viewport renders on a cache miss
const SCAN_CONCURRENCY = num(process.env.LIVE_DESIGN_SCAN_CONCURRENCY, 6);
const CAPTURE_CONCURRENCY = num(process.env.LIVE_DESIGN_CAPTURE_CONCURRENCY, 2);
const MAX_GROUP_SCAN = num(process.env.LIVE_DESIGN_MAX_GROUP_SCAN, 40);

const sharedPageCache = createFetchCache();
const captureLimiter = createLimiter(CAPTURE_CONCURRENCY);

export async function defaultFetchHtml(url, { signal } = {}) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; ZunkireeDesignValidation/1.0)' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow',
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { httpStatus: res.status });
  return res.text();
}

// Captures ONE page in a real browser and returns the same entry shape as
// profile.pages (url, pageType, sections). At most CAPTURE_CONCURRENCY browsers
// run at once across the whole process.
export async function defaultCaptureFn(url, { propertyType } = {}) {
  return captureLimiter(async () => {
    const { launchBrowser, capturePage } = await import('../live-analysis/capture.js');
    const { segmentSite } = await import('../live-analysis/segment.js');
    const { classifyPageType } = await import('../live-analysis/schema.js');
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const captured = await capturePage(page, url);
      const pageType = classifyPageType(url, { propertyType });
      const [seg] = segmentSite({ pages: [{ ...captured, pageType }] });
      return { url, pageType, sections: seg.sections };
    } finally {
      await browser.close().catch(() => {});
    }
  });
}

// Rendered visual check (visual-design-check.js), cached per URL for 10 minutes so a group sample is
// rendered once, not once per page validated against it.
const tokenCache = createFetchCache({ ttlMs: 10 * 60_000, maxEntries: 200 });
export async function defaultVisualCheck(pageUrl, sampleUrl) {
  const { renderDesignTokens, compareDesignTokens, visualCheckEnabled } = await import('./visual-design-check.js');
  if (!visualCheckEnabled()) return { verdict: 'skipped', issues: [] };
  const [a, b] = await Promise.all([tokenCache(pageUrl, () => renderDesignTokens(pageUrl)), tokenCache(sampleUrl, () => renderDesignTokens(sampleUrl))]);
  return compareDesignTokens(a, b);
}

async function mapLimit(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── Design context ─────────────────────────────────────────────────────────
// The ONE object the page-template builder and the composer both read.

function patternFromSections(sections) {
  const body = (sections || []).filter((s) => !['nav', 'header', 'footer'].includes(s.role));
  const byRole = new Map();
  for (const sec of body) {
    for (const item of sec.textHierarchy || []) {
      if (!['heading', 'subheading', 'body'].includes(item.role)) continue;
      if (!byRole.has(item.role)) byRole.set(item.role, new Map());
      const m = byRole.get(item.role);
      const key = item.classes || '';
      m.set(key, (m.get(key) || 0) + 1);
    }
  }
  const textHierarchy = [...byRole.entries()].map(([role, m]) => {
    const [classes] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return { role, classes: classes || null, styleNotes: 'Observed on the validated sample page.' };
  });
  return { sectionOrder: (sections || []).map((s) => s.role).filter(Boolean), textHierarchy };
}

export function buildDesignContext({ status, source, pageUrl, groupId = null, sampleUrl = null, entry, fingerprint, signals = null, liveHtml = '', provisional = false, now = new Date() }) {
  const sections = entry?.sections || [];
  return {
    version: DESIGN_CONTEXT_VERSION,
    status,
    source, // 'group-sample' | 'fresh-capture' | 'remembered-capture'
    provisional,
    pageUrl,
    pagePath: pathKey(pageUrl),
    groupId,
    sampleUrl,
    pageType: entry?.pageType || null,
    fingerprint: fingerprint ? { version: fingerprint.version, hash: fingerprint.hash, count: fingerprint.count } : null,
    signals,
    validatedAt: now.toISOString(),
    sections,
    pattern: patternFromSections(sections),
    // Every class the validated live page really uses: the vocabulary an edit
    // may draw from without inventing anything.
    vocabulary: [...liveClassSet(liveHtml), ...capturedClasses(sections)].filter((v, i, a) => a.indexOf(v) === i),
  };
}

export function attachValidatedContext(site, context) {
  if (!site || !context?.pagePath) return site;
  return { ...site, validatedDesignContext: { ...(site.validatedDesignContext || {}), [context.pagePath]: context } };
}

// A context validated for THIS draft is found on the site snapshot it was attached
// to, or — for code that re-fetched the site itself, like every generator —
// in the draft's async scope (design-context-scope.js).
export function validatedContextFor(site, pageUrl) {
  const key = pageUrl ? pathKey(pageUrl) : null;
  return (key && site?.validatedDesignContext?.[key]) || scopedDesignContextFor(pageUrl) || null;
}

// ── The validation ─────────────────────────────────────────────────────────
//
// Pure with respect to storage: it NEVER changes the group map. Where the evidence
// suggests the saved map should change, it returns a PROPOSAL; a person applies
// proposals through design-review-store.js. The current edit still gets a
// correct design: either a group sample proven current against the live page, or a
// fresh capture of this very page (marked provisional).

const blocked = (reason, detail, { transient = true, ...extra } = {}) => ({ status: 'blocked', reason, detail, transient, context: null, proposal: null, ...extra });

// One cached, de-duplicated read of a live page and its layout fingerprint. Shared by
// the validation stage (memo check) and validatePageDesign, so a page is fetched once.
export function loadLivePage(pageCache, siteId, url, fetchHtml, signal) {
  return pageCache(`${siteId}|${url}`, async () => {
    const html = await fetchHtml(url, { signal });
    return { html, fp: computeLayoutFingerprint(html) };
  });
}
export const sharedLivePageCache = () => sharedPageCache;

export async function validatePageDesign(site, pageUrl, {
  fetchHtml = defaultFetchHtml,
  captureFn = defaultCaptureFn,
  pageCache = sharedPageCache,
  now = () => new Date(),
  deadlineMs = OVERALL_DEADLINE_MS,
  scanConcurrency = SCAN_CONCURRENCY,
  maxGroupScan = MAX_GROUP_SCAN,
  visualCheck = defaultVisualCheck,
} = {}) {
  const profile = site?.url_file_map?.siteRoot?.designProfile;
  if (!pageUrl) return { status: 'skipped', reason: 'no-page-url', context: null, proposal: null };
  if (!profile?.layoutGroups?.groups?.length) {
    // A site that has never had a layout survey has no groups to validate
    // against. Reported as skipped, honestly — NOT as validated.
    return { status: 'skipped', reason: 'no-layout-survey', context: null, proposal: null };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('deadline')), deadlineMs);
  const live = (url) => loadLivePage(pageCache, site.id, url, fetchHtml, ac.signal);
  const absUrl = (path) => { try { return new URL(path, pageUrl).href; } catch { return null; } };

  try {
    return await run();
  } catch (err) {
    if (ac.signal.aborted) return blocked('validation-timeout', `Validation exceeded ${Math.round(deadlineMs / 1000)}s.`);
    return blocked('validation-error', err.message);
  } finally {
    clearTimeout(timer);
  }

  async function run() {
    let page;
    try { page = await live(pageUrl); } catch (err) {
      // 404 / 410: the page appears to be deleted — a different situation from an outage (handled by
      // the stage: confirmed twice, then a page-gone proposal for review).
      if (err.httpStatus === 404 || err.httpStatus === 410) return blocked('page-gone', `The live page returned HTTP ${err.httpStatus}.`, { transient: false, httpStatus: err.httpStatus });
      return blocked('page-unreachable', `Could not read the live page: ${err.message}`, { transient: !(err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 408 && err.httpStatus !== 429), httpStatus: err.httpStatus ?? null });
    }
    // Unreadable = the served HTML has no structure at all (a page built only in the browser: an empty
    // <div id="root">). A simple static page with a few classed sections is readable.
    if (isUnreadableFingerprint(page.fp)) {
      return blocked('page-structure-unreadable', 'The served HTML carries no usable structure (the page may be built only in the browser).', { transient: false });
    }

    const stamp = (fp) => ({ version: FINGERPRINT_VERSION, fingerprint: { hash: fp.hash, count: fp.count }, capturedAt: now().toISOString() });
    const ctxFrom = (args) => buildDesignContext({ ...args, pageUrl, liveHtml: page.html, now: now() });
    const base = { fingerprint: { version: page.fp.version, hash: page.fp.hash, count: page.fp.count } };

    // One capture of THIS page, used whenever no group sample can be trusted.
    // Concurrent validations of the same page (same layout) share one capture.
    const provisionalCapture = async (reason, signals, proposalKind, groupId = null) => {
      let entry;
      try {
        entry = await captureOnce(`${site.id}|${pathKey(pageUrl)}|${page.fp.hash}`, () => captureFn(pageUrl, { propertyType: site?.property_type, signal: ac.signal }));
        if (!entry?.sections?.length) throw new Error('capture returned no sections');
      } catch (err) {
        return blocked('capture-failed', `${reason}; and a fresh capture of this page failed: ${err.message}`);
      }
      const capture = stamp(page.fp);
      return {
        status: 'provisional', reason, transient: false, ...base, signals,
        context: ctxFrom({ status: 'provisional', source: 'fresh-capture', provisional: true, groupId, entry, fingerprint: page.fp, signals }),
        proposal: { kind: proposalKind, groupId, pageUrl, entry: { ...entry, capture }, capture, reason, signals },
      };
    };

    // Is this group sample's recorded design still accurate for its live page?
    const sampleCurrent = async (group) => {
      const entry = (profile.pages || []).find((p) => pathKey(p.url) === pathKey(group.sample));
      if (!entry) return { fail: 'sample-not-captured' };
      const sampleUrl = absUrl(group.sample);
      let sampleLive;
      try { sampleLive = pathKey(sampleUrl) === pathKey(pageUrl) ? page : await live(sampleUrl); } catch { return { fail: 'sample-unreachable' }; }
      const cov = captureCoverage(entry.sections, sampleLive.html);
      if (cov.coverage === null || cov.coverage < MIN_CAPTURE_COVERAGE) return { fail: 'sample-stale', coverage: cov.coverage };
      return { entry, sampleLive, sampleUrl, coverage: cov.coverage };
    };

    // Structure matched; does it also LOOK like its sample at desktop, tablet and mobile? A visual
    // difference is treated like a layout change (fresh capture, proposal); a check that cannot run
    // blocks (transient) — a match is never assumed.
    const visuallyConfirm = async (group, signals) => {
      if (!visualCheck) return { ok: true, visual: null };
      const sampleUrl = absUrl(group.sample);
      if (pathKey(sampleUrl) === pathKey(pageUrl)) return { ok: true, visual: { verdict: 'self' } };
      let v;
      try { v = await visualCheck(pageUrl, sampleUrl); } catch (err) {
        return { ok: false, result: blocked('visual-check-failed', `The rendered comparison could not run: ${err.message}`, { groupId: group.id }) };
      }
      if (v.verdict === 'match' || v.verdict === 'skipped') return { ok: true, visual: { verdict: v.verdict, issues: 0 } };
      if (v.verdict === 'unmeasurable') return { ok: false, result: blocked('visual-check-failed', v.issues?.[0]?.detail || 'nothing measurable on the rendered page', { groupId: group.id }) };
      const summary = v.issues.slice(0, 4).map((i) => `${i.viewport} ${i.kind}: ${i.detail}`).join('; ');
      return { ok: false, result: await provisionalCapture(`structure matches ${group.id} but the rendered design differs (${summary})`, { ...signals, visual: { verdict: 'regression', issues: v.issues.slice(0, 20) } }, 'new-group', null).then((r) => (r.status === 'provisional' ? { ...r, uncertain: true, visualMismatch: true } : r)) };
    };

    const assigned = layoutGroupFor(profile, pageUrl);
    let assignedSignals = null;

    if (assigned) {
      const sampleUrl = absUrl(assigned.sample);
      let sampleLive;
      try { sampleLive = pathKey(sampleUrl) === pathKey(pageUrl) ? page : await live(sampleUrl); } catch {
        return blocked('group-sample-unreachable', `Cannot read this page's group sample (${assigned.sample}) to compare against, and a stale design is not used.`, { groupId: assigned.id });
      }
      assignedSignals = compareLayouts(page.fp, sampleLive.fp);
      if (assignedSignals.verdict === 'match') {
        const cur = await sampleCurrent(assigned);
        if (!cur.fail) {
          const vis = await visuallyConfirm(assigned, assignedSignals);
          if (!vis.ok) return vis.result;
          assignedSignals = { ...assignedSignals, visual: vis.visual };
          return {
            status: 'matched', reason: 'layout matches its group sample', transient: false, ...base, signals: assignedSignals, groupId: assigned.id, proposal: null,
            context: ctxFrom({ status: 'matched', source: 'group-sample', groupId: assigned.id, sampleUrl: assigned.sample, entry: cur.entry, fingerprint: page.fp, signals: assignedSignals }),
          };
        }
        // Same layout, but the group's RECORD is out of date. This page is not allowed to
        // become the group's baseline by itself: it is used for this edit and proposed.
        return provisionalCapture(`matches its group but the group's recorded sample is out of date (${cur.fail}${cur.coverage != null ? `, ${cur.coverage} of its recorded classes still exist` : ''})`, assignedSignals, 'replace-sample', assigned.id);
      }
    }

    // No group, or it does not match its own: does any OTHER group's sample match?
    const candidates = (profile.layoutGroups.groups || []).filter((g) => !assigned || g.id !== assigned.id).slice(0, maxGroupScan);
    const scanned = await mapLimit(candidates, scanConcurrency, async (g) => {
      try { const sl = await live(absUrl(g.sample)); return { g, cmp: compareLayouts(page.fp, sl.fp) }; } catch { return null; }
    });
    const reachable = scanned.filter(Boolean);
    const best = reachable.sort((a, b) => b.cmp.similarity - a.cmp.similarity)[0] || null;
    if (best?.cmp.verdict === 'match') {
      const cur = await sampleCurrent(best.g);
      if (!cur.fail) {
        const vis = await visuallyConfirm(best.g, best.cmp);
        if (!vis.ok) return vis.result;
        best.cmp = { ...best.cmp, visual: vis.visual };
        return {
          status: 'matched-other-group', reason: `layout matches group ${best.g.id} (this page is not assigned to it)`, transient: false, ...base, signals: best.cmp, groupId: best.g.id,
          context: ctxFrom({ status: 'matched-other-group', source: 'group-sample', groupId: best.g.id, sampleUrl: best.g.sample, entry: cur.entry, fingerprint: page.fp, signals: best.cmp }),
          // Reassigning a page to a group is a baseline decision: proposed, never applied automatically.
          proposal: { kind: 'join', groupId: best.g.id, pageUrl, reason: 'page matches this group but is not assigned to it', signals: best.cmp },
        };
      }
    }

    const nearest = [assignedSignals, best?.cmp].filter(Boolean).sort((a, b) => b.similarity - a.similarity)[0] || null;
    const why = assigned ? `its group's layout no longer matches (${assignedSignals.similarity} similar)` : 'it has no layout group yet';
    const uncertain = nearest && nearest.verdict === 'uncertain';
    return provisionalCapture(
      uncertain ? `${why}; closest known layout is only an uncertain match` : why,
      nearest, 'new-group', null,
    ).then((r) => (r.status === 'provisional' && uncertain ? { ...r, uncertain: true } : r));
  }
}

// ── Final design-integrity check on an edit ────────────────────────────────

function profileVocabulary(profile) {
  const out = new Set();
  const visit = (node) => {
    if (!node) return;
    if (typeof node === 'string') { classTokens(node).forEach((c) => out.add(c)); return; }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(profile?.typography); visit(profile?.color); visit(profile?.spacing); visit(profile?.layout); visit(profile?.components);
  return out;
}

function templateVocabulary(componentTemplates) {
  const out = new Set();
  for (const t of Object.values(componentTemplates || {})) {
    for (const part of [t?.wrapper, t?.row]) {
      for (const m of String(part || '').matchAll(/class="([^"]*)"/g)) classTokens(m[1]).forEach((c) => out.add(c));
    }
  }
  return out;
}

export function extractClassesFromHtml(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/\s(?:class|className)\s*=\s*\{?\s*(?:"([^"]*)"|'([^']*)')/g)) classTokens(m[1] ?? m[2]).forEach((c) => out.add(c));
  return out;
}

const INLINE_STYLE_RISK = /(^|;)\s*(color|background(?:-color)?|font(?:-family|-size|-weight)?|margin|padding|width|height|border|line-height|letter-spacing)\s*:/i;

/**
 * Compares what an edit ADDS to a page against the design that page really has.
 * Pure. `before` / `after` are the page source before and after the edit.
 *
 * Fails when the edit introduces a class that exists nowhere in this page's own
 * source, its validated live vocabulary, the site's captured design vocabulary
 * or its verified component templates; adds inline colour/font/spacing styles;
 * or adds <style>/<script>. Anything the page already used is allowed — the
 * edit preserves the existing design; it does not extend it.
 */
export function checkEditDesignIntegrity({ before = '', after = '', context = null, profile = null, componentTemplates = null, extraVocabulary = null, allowScripts = false }) {
  const allowed = new Set([
    ...extractClassesFromHtml(before),
    ...(context?.vocabulary || []),
    ...(extraVocabulary || []),
    ...profileVocabulary(profile),
    ...templateVocabulary(componentTemplates),
  ]);
  const issues = [];
  const added = [...extractClassesFromHtml(after)].filter((c) => !allowed.has(c));
  if (added.length) issues.push({ type: 'unknown-class', detail: `Edit introduces ${added.length} class(es) this page and site never use: ${added.slice(0, 8).join(', ')}`, classes: added });

  const stylesBefore = new Set([...String(before).matchAll(/\sstyle\s*=\s*"([^"]*)"/g)].map((m) => m[1]));
  const newStyles = [...String(after).matchAll(/\sstyle\s*=\s*"([^"]*)"/g)].map((m) => m[1]).filter((st) => !stylesBefore.has(st) && INLINE_STYLE_RISK.test(st));
  if (newStyles.length) issues.push({ type: 'inline-style', detail: `Edit adds inline design styles (${newStyles.slice(0, 3).join(' | ')}); the page's design lives in its classes.` });

  // <script type="application/ld+json"> is data, not behaviour or design; other scripts and any <style> are checked.
  const designTags = (src, tag) => (String(src).match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) || []).filter((t) => !/ld\+json/i.test(t)).length;
  if (designTags(after, 'style') > designTags(before, 'style')) issues.push({ type: 'new-style-tag', detail: 'Edit adds a <style> element.' });
  if (!allowScripts && designTags(after, 'script') > designTags(before, 'script')) issues.push({ type: 'new-script-tag', detail: 'Edit adds a <script> element.' });
  return { ok: issues.length === 0, issues };
}

// 'enforce' (default) blocks the edit, 'log' records and lets it through, 'off' skips.
export function pageDesignIntegrityMode(env = process.env) {
  const v = String(env.PAGE_DESIGN_INTEGRITY ?? 'enforce').toLowerCase();
  return ['enforce', 'log', 'off'].includes(v) ? v : 'enforce';
}

export function liveDesignValidationEnabled(env = process.env) {
  return String(env.LIVE_DESIGN_VALIDATION ?? 'true').toLowerCase() !== 'false';
}
