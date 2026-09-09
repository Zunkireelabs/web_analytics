import { query } from '../db.js';

// Sources with a real page_url and a real, already-callable per-page
// deterministic recheck function: opportunity (recommendationsFor) and
// content-gap (contentGapsFor) — see agents/lib/fix-verification.js for the
// source-aware branching between them. ai-visibility's findings are
// structural/site-level (no comparable single-page recheck), and anything
// from country-intelligence (landing-page/translation) produces brand-new
// content with no resulting URL — those stay on the existing
// hasDraftSince() heuristic instead of a faked verification.
const VERIFIABLE_SOURCES = new Set(['opportunity', 'content-gap']);
// Exported so routes/action-center.js's checkDraftPrStatus knows which
// generator ids already get a real fix-verification recheck (and therefore
// already write to agent_fix_memory via fix-verification.js) — everything
// else falls back to PR-merge/abandon as its only available outcome signal,
// which means the health/AI-visibility scores trust a merge forever with no
// live re-check for anything not in this set.
//
// canonical/open-graph/breadcrumbs/qa-content added 2026-08-15: each has a
// real, deterministic, tag-mapped detection check already reachable through
// contentGapsFor (agents/lib/page-content.js's contentGapChecks — 'Missing
// canonical tag'/'Canonical points to a different domain'/'Missing Open
// Graph tags'/'Missing breadcrumbs'/'Missing question-style headings', all
// wired via GAP_TYPE_TO_GENERATOR), the same mechanism already proven for
// faq/schema above — no new per-type verification code needed, this is a
// Set-membership change only.
//
// Deliberately NOT added: expand-content, translation, landing-page,
// blog-outline, and the legal pages — all LLM-authored prose. "Does this
// page still say the right thing" is a different, harder problem than "is
// this tag present", and there is no real check here that would verify
// content correctness rather than just re-running a presence check against
// prose — adding them would be exactly the kind of fabricated verification
// this mechanism exists to avoid.
export const VERIFIABLE_GENERATOR_IDS = new Set([
  'meta-title', 'faq', 'schema', 'internal-links',
  'canonical', 'open-graph', 'breadcrumbs', 'qa-content',
]);

// analytics-install (trust-compliance.js) is verified differently from the
// set above — not a tag re-check (recommendationsFor/contentGapsFor have no
// concept of "GA4/Pixel installed"), but a literal, direct check that the
// SPECIFIC configured tracking ID this draft shipped is now really present in
// the live page's HTML — see fix-verification.js's verifyAnalyticsInstall.
// Reuses this same scheduling table/machinery rather than a bespoke one.
const TRACKING_ID_VERIFIABLE_GENERATOR_IDS = new Set(['analytics-install']);

export function isVerifiableDraft(draft) {
  // finding_origin (migration 119) is the real detecting agent, preserved
  // separately from `source` (which auto-remediation.js/execution-engine
  // overwrite with their own shipping-mechanism label) — fall back to
  // `source` for rows with no recorded origin (pre-migration rows, or a
  // caller with no separate origin to give, e.g. a manual click where
  // `source` already IS the real detecting agent).
  const origin = draft.finding_origin || draft.source;

  if (TRACKING_ID_VERIFIABLE_GENERATOR_IDS.has(draft.action_type)) {
    // A placeholder draft (no real ID known at generation time) has nothing
    // to verify yet — never schedule a check for a script that was never
    // installed with a real tracking ID in the first place.
    return origin === 'trust-compliance'
      && !!draft.finding_id
      && !!draft.input?.page
      && !!draft.input?.trackingId
      && !draft.content?.placeholderFields?.length;
  }

  return VERIFIABLE_SOURCES.has(origin)
    && !!draft.finding_id
    && VERIFIABLE_GENERATOR_IDS.has(draft.action_type)
    && !!draft.input?.page;
}

// ---------------------------------------------------------------------------
// Verification coverage for EVERY generator (migration 153)
// ---------------------------------------------------------------------------
//
// isVerifiableDraft above covers the 9 original types and is left exactly as
// it was, because store/drafts.js's markDraftImplemented still calls it and
// that file is owned elsewhere. Everything below is the wider coverage layer:
// routes/action-center.js's finalizeImplemented calls
// scheduleVerificationForDraft after a merge is observed, which schedules a
// check for any draft the narrow path above did not already take.
//
// The governing rule is the same one that produced the original allowlist:
// never fabricate verification. Each method below re-checks real, externally
// observable evidence. Where a change genuinely leaves no checkable evidence,
// the method is 'unverifiable' and the row records WHY — which is explicitly
// not the same as, and never counted as, 'verified-fixed'.
export const VERIFICATION_METHOD = {
  TAG_RECHECK: 'tag-recheck',       // re-run the detector that flagged it
  TRACKING_ID: 'tracking-id',       // the exact shipped tracking ID is live
  SITE_ASSET: 'site-asset',         // a well-known file is served at the origin
  RESPONSE_HEADER: 'response-header', // the shipped header is really being sent
  PAGE_PATTERN: 'page-pattern',     // a deterministic pattern holds in live HTML
  PAGE_ABSENCE: 'page-absence',     // something that had to go is really gone
  REDIRECT: 'redirect',             // the old URL now lands somewhere else
  PAGE_CONTENT: 'page-content',     // the shipped copy is present on the page
  REPO_FILE: 'repo-file',           // the shipped copy is in the merged branch
  UNVERIFIABLE: 'unverifiable',     // nothing checkable — recorded with a reason
};

// Well-known site-level assets: (path, structural check name).
const SITE_ASSET_TARGETS = {
  'llms-txt': { path: '/llms.txt', structure: 'llms-txt' },
  'robots-fix': { path: '/robots.txt', structure: null },
  sitemap: { path: '/sitemap.xml', structure: null },
};

// Deterministic live-HTML patterns, checked by fix-verification.js. Kept as
// method + a named check rather than a serialized regex so the actual matching
// logic stays in code that can be read and tested.
const PAGE_PATTERN_CHECKS = {
  'html-lang': 'html-lang-present',
  viewport: 'viewport-meta-present',
  'duplicate-id-fix': 'no-duplicate-ids',
};

// Generators whose whole purpose is to report, not to change anything. There
// is no shipped artifact to look for, and saying so plainly is the honest
// outcome — the alternative is a check that trivially "passes" and quietly
// inflates the verified count.
const REPORT_ONLY_GENERATORS = {
  'geo-audit': 'geo-audit produces an audit report rather than a change to the site, so there is no shipped artifact to re-check.',
};

// Prose long enough to be a distinctive fingerprint of the shipped change.
// Below this, a match proves nothing (short strings collide with boilerplate
// that was already on the page).
const MIN_EXCERPT_CHARS = 40;
const EXCERPT_MATCH_CHARS = 70;

// Walks a draft's generated content and returns the longest natural-language
// string in it. Generator-agnostic on purpose: content shapes differ per
// generator (expand-content has {sections}, blog-image has {imageAlt}, ...) and
// hardcoding a field per type would rot the moment a generator changes shape.
export function longestTextExcerpt(value, seen = new Set()) {
  let best = '';
  const walk = (node) => {
    if (node == null) return;
    if (typeof node === 'string') {
      const text = node.replace(/\s+/g, ' ').trim();
      // Must read as prose — a bare class name, path or slug is not evidence.
      if (text.length > best.length && text.includes(' ') && !text.startsWith('<')) best = text;
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, child] of Object.entries(node)) {
      // appliedFiles carries whole rendered file bodies — matching against a
      // file body would verify the commit, not the live page, and is handled
      // by the repo-file method instead.
      if (key === 'appliedFiles') continue;
      walk(child);
    }
  };
  walk(value);
  return best;
}

// The slice actually matched against the live page. Taken from the middle of
// the excerpt: generated prose frequently starts or ends with markdown or
// template punctuation that the site's own renderer rewrites, while the middle
// survives verbatim.
export function excerptNeedle(excerpt) {
  if (!excerpt || excerpt.length < MIN_EXCERPT_CHARS) return null;
  if (excerpt.length <= EXCERPT_MATCH_CHARS) return excerpt;
  const start = Math.floor((excerpt.length - EXCERPT_MATCH_CHARS) / 2);
  return excerpt.slice(start, start + EXCERPT_MATCH_CHARS);
}

function pageUrlFor(draft) {
  return draft?.input?.page || draft?.content?.page || null;
}

// Decides, once, how a given merged draft is to be re-checked. Returns
// { method, target, expected, reason } — `reason` is only ever set for
// UNVERIFIABLE, and is the text recorded on the row.
export function verificationMethodFor(draft, { siteOrigin = null } = {}) {
  const type = draft?.action_type;
  const page = pageUrlFor(draft);

  if (REPORT_ONLY_GENERATORS[type]) {
    return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: REPORT_ONLY_GENERATORS[type] };
  }

  // Strongest available check wins: when a draft qualifies for the original
  // detector re-run (the exact check that flagged it), use that rather than a
  // weaker presence check. Keeps this function's answer identical to what
  // markDraftImplemented's narrow path would have scheduled, so the two can
  // never disagree about how a given draft ought to be verified.
  if (isVerifiableDraft(draft)) {
    return { method: VERIFICATION_METHOD.TAG_RECHECK, target: page };
  }

  if (TRACKING_ID_VERIFIABLE_GENERATOR_IDS.has(type)) {
    return { method: VERIFICATION_METHOD.TRACKING_ID, target: page, expected: { trackingId: draft?.input?.trackingId ?? null } };
  }

  if (SITE_ASSET_TARGETS[type]) {
    const { path, structure } = SITE_ASSET_TARGETS[type];
    if (!siteOrigin) {
      return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: `No site origin is configured, so ${path} cannot be fetched to confirm it is being served.` };
    }
    return { method: VERIFICATION_METHOD.SITE_ASSET, target: new URL(path, siteOrigin).href, expected: { structure } };
  }

  if (type === 'security-headers') {
    const headers = Object.keys(draft?.content?.headers || draft?.input?.headers || {});
    const target = page || siteOrigin;
    if (!target) {
      return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: 'No page or site origin is available to re-request, so the shipped headers cannot be observed.' };
    }
    return { method: VERIFICATION_METHOD.RESPONSE_HEADER, target, expected: { headers } };
  }

  if (PAGE_PATTERN_CHECKS[type]) {
    const target = page || siteOrigin;
    if (!target) {
      return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: 'No page URL was recorded for this change, so its live HTML cannot be re-checked.' };
    }
    return { method: VERIFICATION_METHOD.PAGE_PATTERN, target, expected: { check: PAGE_PATTERN_CHECKS[type], id: draft?.input?.duplicateId ?? null } };
  }

  if (type === 'broken-link-fix') {
    const href = draft?.input?.href || draft?.input?.brokenUrl || draft?.content?.href || null;
    if (!page || !href) {
      return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: 'The specific broken link this draft removed was not recorded, so its absence cannot be confirmed.' };
    }
    return { method: VERIFICATION_METHOD.PAGE_ABSENCE, target: page, expected: { absent: href } };
  }

  if (type === 'redirect-fix') {
    const from = draft?.input?.from || draft?.input?.page || page;
    if (!from) {
      return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: 'No source URL was recorded for this redirect, so it cannot be re-requested.' };
    }
    return { method: VERIFICATION_METHOD.REDIRECT, target: from, expected: { to: draft?.input?.to ?? draft?.content?.to ?? null } };
  }

  // Everything else ships copy. If we know where it should be visible, check
  // the live page; otherwise fall back to the merged branch, which is still
  // real evidence that the change landed even though it says nothing about
  // whether it is live.
  const excerpt = longestTextExcerpt(draft?.content);
  const needle = excerptNeedle(excerpt);
  if (!needle) {
    const files = (draft?.content?.appliedFiles || []).map((f) => f?.filePath).filter(Boolean);
    if (files.length) return { method: VERIFICATION_METHOD.REPO_FILE, expected: { files } };
    return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: 'This draft shipped no prose long enough to identify on the live page, and recorded no file path to re-read.' };
  }
  if (page) {
    return { method: VERIFICATION_METHOD.PAGE_CONTENT, target: page, expected: { needle } };
  }
  const files = (draft?.content?.appliedFiles || []).map((f) => f?.filePath).filter(Boolean);
  if (files.length) return { method: VERIFICATION_METHOD.REPO_FILE, expected: { files, needle } };
  return { method: VERIFICATION_METHOD.UNVERIFIABLE, reason: 'This change has no public URL and no recorded file path, so there is nothing to re-read.' };
}

const DEFAULT_DELAY_HOURS = Number(process.env.FIX_VERIFY_DELAY_HOURS) || 48;

export async function createPendingVerification(siteId, { watchlistItemId, findingId, draftId, pageUrl, generatorId, queryText, source, memoryRefId, method, expected, deploymentId }) {
  const { rows } = await query(
    `INSERT INTO fix_verifications (site_id, watchlist_item_id, finding_id, draft_id, page_url, generator_id, query, source, memory_ref_id, method, expected, deployment_id, verify_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + ($13 * interval '1 hour'))
     RETURNING *`,
    [siteId, watchlistItemId ?? null, findingId, draftId, pageUrl ?? null, generatorId, queryText ?? null, source ?? null, memoryRefId ?? null,
     method ?? null, JSON.stringify(expected ?? null), deploymentId ?? null, DEFAULT_DELAY_HOURS]
  );
  return rows[0];
}

// One verification row per draft, ever. markDraftImplemented (store/drafts.js)
// already schedules the 9 original types; this is what
// routes/action-center.js's finalizeImplemented calls for every draft, so the
// guard is what keeps the two paths from double-scheduling the same work.
export async function hasVerificationForDraft(siteId, draftId) {
  const { rows } = await query(
    'SELECT 1 FROM fix_verifications WHERE site_id = $1 AND draft_id = $2 LIMIT 1',
    [siteId, draftId],
  );
  return rows.length > 0;
}

// Schedules the right kind of re-check for a merged draft, whatever its
// generator. Returns null when one was already scheduled (by this or by
// markDraftImplemented's narrower path). An UNVERIFIABLE draft still gets a
// row — recorded immediately with its reason, so "we cannot check this"
// is visible in the same place as every real outcome instead of being an
// absence nobody can see.
export async function scheduleVerificationForDraft(siteId, draft, { watchlistItemId = null, siteOrigin = null, deploymentId = null } = {}) {
  if (!draft?.id) return null;
  if (await hasVerificationForDraft(siteId, draft.id)) return null;

  const plan = verificationMethodFor(draft, { siteOrigin });
  const row = await createPendingVerification(siteId, {
    watchlistItemId,
    findingId: draft.finding_id || `${draft.action_type}:draft:${draft.id}`,
    draftId: draft.id,
    pageUrl: plan.target ?? draft.input?.page ?? null,
    generatorId: draft.action_type,
    queryText: draft.input?.query ?? draft.input?.trackingId ?? null,
    source: draft.finding_origin || draft.source,
    memoryRefId: draft.memory_ref_id ?? null,
    method: plan.method,
    expected: plan.expected ?? null,
    deploymentId,
  });

  if (plan.method === VERIFICATION_METHOD.UNVERIFIABLE) {
    return recordVerificationOutcome(row.id, 'unverifiable', { reason: plan.reason });
  }
  return row;
}

// Attaches a deployment to verifications already scheduled for a draft — the
// merge is observed (and the deployment row created) in the same breath as
// finalizing the draft, but markDraftImplemented may have inserted its row
// first.
export async function attachDeploymentToDraftVerifications(siteId, draftId, deploymentId) {
  if (!deploymentId) return 0;
  const { rowCount } = await query(
    `UPDATE fix_verifications SET deployment_id = $3
      WHERE site_id = $1 AND draft_id = $2 AND deployment_id IS NULL`,
    [siteId, draftId, deploymentId],
  );
  return rowCount;
}

// Global, not per-site — due-ness here is per-row (verify_after), so there's
// no site-level "is it due" marker to check first. 'awaiting-deployment' rows
// are due again too: they are changes that were checked while their deploy was
// still propagating, and they are meant to come back around.
export async function getDueVerifications(limit = 50) {
  const { rows } = await query(
    `SELECT * FROM fix_verifications
      WHERE outcome IN ('pending', 'awaiting-deployment') AND verify_after <= now()
      ORDER BY verify_after ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function recordVerificationOutcome(id, outcome, evidence) {
  const { rows } = await query(
    `UPDATE fix_verifications SET outcome = $2, evidence = $3, checked_at = now(), attempts = attempts + 1
     WHERE id = $1 RETURNING *`,
    [id, outcome, JSON.stringify(evidence ?? null)]
  );
  return rows[0] || null;
}

// The change is not live yet and its deploy is still inside the grace window.
// Recorded honestly (not as a failure, not as a success) and re-queued.
export async function rescheduleVerification(id, { delayHours, evidence }) {
  const { rows } = await query(
    `UPDATE fix_verifications
        SET outcome = 'awaiting-deployment', evidence = $3, checked_at = now(),
            attempts = attempts + 1, verify_after = now() + ($2 * interval '1 hour')
      WHERE id = $1 RETURNING *`,
    [id, delayHours, JSON.stringify(evidence ?? null)]
  );
  return rows[0] || null;
}

// Every verification row for a site since a given date, newest first — the
// Review Report's (agents/lib/review-report.js) real "did fixes actually
// stick" summary. Global getDueVerifications above is for the scheduler;
// this is the per-site history read.
export async function getVerificationsForSite(siteId, sinceDate) {
  const { rows } = await query(
    `SELECT * FROM fix_verifications WHERE site_id = $1 AND created_at >= $2 ORDER BY created_at DESC`,
    [siteId, sinceDate]
  );
  return rows;
}

// Resolves the Watchlist item (if any) tied to this finding, for the same
// site — used at insert time so the later verification row already knows
// which watchlist item to reopen, without a second lookup. Returns null for
// findings that never qualified for the Watchlist (e.g. low priority).
export async function getWatchlistItemByFindingId(siteId, findingId) {
  const { rows } = await query(
    'SELECT id, status FROM watchlist_items WHERE site_id = $1 AND finding_id = $2',
    [siteId, findingId]
  );
  return rows[0] || null;
}
