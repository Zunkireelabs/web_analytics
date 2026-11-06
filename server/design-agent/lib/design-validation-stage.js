// THE VALIDATION STAGE — what generateDraft runs, per existing-page edit, before generating.
//
// Decides whether the edit needs live validation at all (scope), reuses a remembered
// answer when the page has not changed (dedupe), validates against the live site,
// records the evidence, and turns a block into the right KIND of error.
//
// Error handling is the point of this module's shape. A page that cannot be checked
// right now is NOT:
//   * a refusal   (the no-fabrication policy; counted by the refusal streak, the
//                  refusal cap and the code-repair escalation), and
//   * a failure   (counted by the systemic circuit breaker).
// It is PENDING: the item is skipped, nothing is counted against it, unrelated items
// keep going, and the page is retried with backoff — and, after repeated transient
// failures or a permanent one, parked for a person instead of retried forever.
import { COMPONENT_TEMPLATE_KEY } from '../../implementers/lib/design-drift.js';
import {
  validatePageDesign, liveDesignValidationEnabled, attachValidatedContext, buildDesignContext, pathKey,
  loadLivePage, sharedLivePageCache, defaultFetchHtml,
} from './live-design-validation.js';
import { createReviewStore, reviewStateOf, lookupMemo } from './design-review-store.js';

export const SITE_KEY = '/__site__';

// Serializes validation of ONE page across workers (Postgres advisory lock), so two workers never
// capture the same page at once; the second re-reads the first one's result instead. Falls back to
// no lock (per-process de-duplication still applies) if the database is unavailable.
export async function defaultPageLock(siteId, pagePath, { waitMs = 90_000 } = {}) {
  let client;
  try { client = await (await import('../../db.js')).pool.connect(); } catch { return async () => {}; }
  client.on('error', () => {});
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await client.query('SELECT pg_try_advisory_lock(72002, hashtext($1)) AS ok', [`${siteId}|${pagePath}`]);
      if (rows[0].ok) break;
      if (Date.now() >= deadline) { client.release(); return async () => {}; }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch { client.release(true); return async () => {}; }
  return async () => { try { await client.query('SELECT pg_advisory_unlock(72002, hashtext($1))', [`${siteId}|${pagePath}`]); } catch { /* session gone */ } client.release(); };
}

// Generators whose output changes what a visitor SEES on an existing page. Everything else
// (meta tags, schema, canonical, redirects, robots, sitemap, alt text, lang, viewport,
// broken-link fixes…) edits the head or an attribute and has no design to validate.
// Derived from the component-template concept plus the visible-markup writers that have none.
const EXTRA_DESIGN_AFFECTING = ['refresh-content', 'blog-image', 'breadcrumbs'];
export const DESIGN_AFFECTING_GENERATORS = new Set([
  ...Object.keys(COMPONENT_TEMPLATE_KEY).filter((k) => k !== 'content-wrapper'),
  ...EXTRA_DESIGN_AFFECTING,
]);
export const isDesignAffectingGenerator = (generatorId) => DESIGN_AFFECTING_GENERATORS.has(generatorId);

export class DesignValidationPending extends Error {
  constructor(message, { reason, detail = null, transient = true, exhausted = false, pageUrl = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'DesignValidationPending';
    this.status = 503;            // honest HTTP answer: not available right now
    this.userFacing = true;
    this.designPending = true;    // auto-remediation: skip this item, count nothing, keep going
    this.reason = 'design-validation-pending';
    this.pendingReason = reason;
    this.detail = detail;
    this.transient = transient;
    this.exhausted = exhausted;
    this.pageUrl = pageUrl;
    this.retryAfter = retryAfter;
  }
}

/** True for the error above, however it was wrapped. */
export const isDesignPending = (err) => err?.designPending === true;

const MEMO_REUSABLE = new Set(['matched', 'matched-other-group', 'provisional']);

export async function runDesignValidationStage({
  site, generatorId, pageUrl,
  validate = validatePageDesign,
  store = null,
  fetchHtml = defaultFetchHtml,
  pageCache = sharedLivePageCache(),
  env = process.env,
  now = () => new Date(),
  log = console,
  pageLock = defaultPageLock,
} = {}) {
  const skip = (reason) => ({ outcome: 'skipped', reason, site, context: null });
  if (!liveDesignValidationEnabled(env)) return skip('disabled');
  if (!isDesignAffectingGenerator(generatorId)) return skip('not-design-affecting');
  if (!pageUrl || !site) return skip('no-page-url');

  const siteRoot = site.url_file_map?.siteRoot || {};
  const pagePath = pathKey(pageUrl);
  const reviewStore = store || createReviewStore({ now });
  // The page's remembered result (and the proposal it points at), from whichever backend holds it.
  const loadState = async () => {
    const load = async (key) => (reviewStore.loadPageState ? await reviewStore.loadPageState(site, key).catch(() => null) : null) || reviewStateOf(siteRoot);
    const [pageState, siteState] = await Promise.all([load(pagePath), load(SITE_KEY)]);
    return { ...pageState, pageResults: { ...(siteState.pageResults || {}), ...(pageState.pageResults || {}) } };
  };
  let state = await loadState();

  // 0. The whole site is down (detected below): fail fast, no fetch, no capture, until the backoff ends.
  const siteDown = lookupMemo(state, SITE_KEY, null, now());
  if (siteDown && siteDown.usable === false) {
    throw new DesignValidationPending(`${generatorId} is waiting: ${site.name || `site ${site.id}`} was unreachable; next check after ${siteDown.retryAfter}.`,
      { reason: 'site-unreachable', transient: true, pageUrl, retryAfter: siteDown.retryAfter });
  }
  const started = Date.now();
  const persist = async (record) => {
    // Evidence and memory are best-effort: failing to record must never fail an edit.
    try { return await reviewStore.recordValidation(site.id, { pagePath, ...record }); } catch (err) {
      log.warn?.(`[design-validation] could not record the result for site ${site.id} ${pagePath}: ${err.message}`);
      return null;
    }
  };
  const evidenceBase = { kind: 'validation', generatorId, pagePath };

  // 1. A page that is already waiting (backoff, or parked for review) is not re-fetched or re-captured.
  const waiting = lookupMemo(state, pagePath, null, now());
  if (waiting && waiting.usable === false) {
    throw new DesignValidationPending(
      waiting.waitingFor === 'review'
        ? `${generatorId} is waiting for a design review of this page (${waiting.reason}). It will resume when the page is reviewed or changes.`
        : `${generatorId} is waiting to re-check this page's current design (${waiting.reason}); next attempt after ${waiting.retryAfter}.`,
      { reason: waiting.reason, transient: waiting.transient !== false, exhausted: waiting.waitingFor === 'review', pageUrl, retryAfter: waiting.retryAfter },
    );
  }

  // 2. An unchanged page with a remembered answer is not re-compared or re-captured.
  async function reuseRemembered(st) {
    let hit = null;
    try {
      const live = await loadLivePage(pageCache, site.id, pageUrl, fetchHtml);
      const memo = lookupMemo(st, pagePath, live.fp.hash, now());
      if (memo?.usable && MEMO_REUSABLE.has(memo.outcome)) hit = { memo, live };
    } catch { /* the validation below reports an unreadable page properly */ }
    if (!hit) return null;
    const { memo, live } = hit;
    let entry = null; let source = 'group-sample'; const groupId = memo.groupId || null; let sampleUrl = null; let provisional = false;
    const profile = siteRoot.designProfile || {};
    if (memo.outcome === 'provisional') {
      const prop = st.provisional?.[memo.provisionalId];
      if (prop?.entry && prop.status === 'pending') { entry = prop.entry; source = 'remembered-capture'; provisional = true; }
    } else {
      const g = (profile.layoutGroups?.groups || []).find((x) => x.id === memo.groupId);
      if (g) { entry = (profile.pages || []).find((p) => pathKey(p.url) === pathKey(g.sample)) || null; sampleUrl = g.sample; }
    }
    if (!entry) return null; // remembered data is gone (proposal decided, group changed): validate afresh
    const context = buildDesignContext({ status: memo.outcome, source, provisional, pageUrl, groupId, sampleUrl, entry, fingerprint: live.fp, signals: memo.signals || null, liveHtml: live.html, now: now() });
    await persist({ evidence: { ...evidenceBase, status: memo.outcome, memo: 'hit', ms: Date.now() - started } });
    return { outcome: memo.outcome, reason: 'remembered result for an unchanged page', memo: 'hit', site: attachValidatedContext(site, context), context };
  }
  const remembered = await reuseRemembered(state);
  if (remembered) return remembered;

  // 3. Validate against the live site — one worker per page at a time.
  // The lock is held until the result is SAVED (not just computed): released earlier, a second worker
  // could take it in the gap, find nothing remembered yet, and validate/capture the page again.
  const release = await pageLock(site.id, pagePath).catch(() => async () => {});
  try {
    return await validateAndRecord();
  } finally {
    await release().catch(() => {});
  }

  async function validateAndRecord() {
  // Another worker may have validated this page while we waited for the lock: reuse its answer.
  if (pageLock !== noPageLock) {
    state = await loadState();
    const fresh = await reuseRemembered(state);
    if (fresh) return fresh;
  }
  let result;
  try { result = await validate(site, pageUrl); } catch (err) {
    result = { status: 'blocked', reason: 'validation-error', detail: err.message, transient: true, context: null, proposal: null };
  }

  if (result.status === 'skipped') return { ...skip(result.reason), outcome: 'skipped' };

  if (result.status === 'blocked' && result.reason === 'page-gone') {
    // First sighting: wait (>= 1 hour) and look again — a deploy can briefly 404 a real page.
    // Second consecutive sighting: propose 'page-gone' for review and park the page.
    const prev = state.pageResults?.[pagePath];
    const confirmed = prev?.outcome === 'blocked' && prev.reason === 'page-gone';
    await persist({
      evidence: { ...evidenceBase, status: 'blocked', reason: 'page-gone', confirmed, memo: 'miss', ms: Date.now() - started },
      result: { outcome: 'blocked', reason: 'page-gone', transient: !confirmed },
      proposal: confirmed ? { kind: 'page-gone', pageUrl, reason: `HTTP ${result.httpStatus || 404} on two checks at least an hour apart`, extra: { httpStatus: result.httpStatus || 404 } } : null,
    });
    throw new DesignValidationPending(
      confirmed
        ? `${generatorId} is held: this page appears to have been deleted (HTTP ${result.httpStatus || 404} twice). It is waiting for a person to confirm; its recommendations close if they do.`
        : `${generatorId} is held: this page returned HTTP ${result.httpStatus || 404}. It will be checked again in an hour before anything is concluded.`,
      { reason: 'page-gone', transient: !confirmed, exhausted: confirmed, pageUrl },
    );
  }

  if (result.status === 'blocked' && result.reason === 'page-unreachable' && result.transient !== false) {
    // Is it this page, or the whole site? One cached probe of the site root decides.
    let siteRootUrl = null;
    try { siteRootUrl = new URL('/', pageUrl).href; } catch { /* ignore */ }
    const siteReachable = siteRootUrl ? await loadLivePage(pageCache, site.id, siteRootUrl, fetchHtml).then(() => true, () => false) : true;
    if (!siteReachable) {
      await persist({ evidence: { ...evidenceBase, status: 'blocked', reason: 'site-unreachable', memo: 'miss' }, result: { outcome: 'blocked', reason: 'page-unreachable', transient: true } });
      try { await reviewStore.recordValidation(site.id, { pagePath: SITE_KEY, result: { outcome: 'blocked', reason: 'site-unreachable', transient: true } }); } catch { /* best-effort */ }
      throw new DesignValidationPending(`${generatorId} is waiting: the site is unreachable right now; every page of it will be retried after a back-off.`, { reason: 'site-unreachable', transient: true, pageUrl });
    }
  }

  if (result.status === 'blocked') {
    await persist({
      evidence: { ...evidenceBase, status: 'blocked', reason: result.reason, transient: result.transient, memo: 'miss', ms: Date.now() - started },
      result: { outcome: 'blocked', reason: result.reason, transient: result.transient !== false },
    });
    throw new DesignValidationPending(
      `${generatorId} is held: this page's current design could not be confirmed against the live site (${result.reason}). `
      + (result.transient === false
        ? 'A stale design is not used; the page needs a design review before it is edited.'
        : 'A stale design is not used; it will be retried automatically.'),
      { reason: result.reason, detail: result.detail, transient: result.transient !== false, pageUrl },
    );
  }

  // matched / matched-other-group / provisional
  const recorded = await persist({
    evidence: {
      ...evidenceBase, status: result.status, reason: result.reason, groupId: result.groupId || result.context?.groupId || null,
      signals: result.signals || null, uncertain: Boolean(result.uncertain), memo: 'miss', ms: Date.now() - started,
    },
    result: { outcome: result.status, fingerprintHash: result.fingerprint?.hash || result.context?.fingerprint?.hash || null, groupId: result.context?.groupId || null, signals: result.signals || null, reason: result.reason },
    proposal: result.proposal || null,
  });
  return {
    outcome: result.status, reason: result.reason, memo: 'miss', proposalId: recorded?.proposalId || null,
    site: attachValidatedContext(site, result.context), context: result.context, signals: result.signals || null,
  };
  }
}

// Pass as `pageLock` to skip cross-worker locking (tests, single-process tools).
export const noPageLock = async () => async () => {};
