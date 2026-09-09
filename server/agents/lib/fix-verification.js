import {
  getDueVerifications, recordVerificationOutcome, rescheduleVerification, VERIFICATION_METHOD,
} from '../../store/fix-verifications.js';
import {
  getDeploymentById, markDeploymentDetected, markDeploymentNotDetected, deploymentGraceElapsed,
} from '../../store/deployments.js';
import { getWatchlistItemById, setWatchlistStatus } from '../../store/watchlist.js';
import {
  analyzePageUrl, recommendationsFor, contentGapsFor, fetchHtml,
  fetchResponseHeaders, fetchTextIfExists, llmsTxtHasValidStructure,
} from './page-content.js';
import { reopenRecommendation } from '../../store/recommendations.js';
import { recordAttempt } from '../../store/recommendation-attempts.js';
import { getFileContent } from '../../github/client.js';
import { RETRY_POLICY } from '../../lib/attempt-classification.js';
import { FAILURE_CLASS } from '../../lib/failure-classification.js';
import { recordFixOutcome } from '../../agent-memory.js';
import { topLevelCategoryForGenerator } from '../../generators/lib/pattern-categories.js';
import { getSiteById } from '../../store/read.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { computeSiteFingerprint } from './site-fingerprint.js';
import { getOrClassifyPageContentType } from './page-content-classifier.js';
import { problemSignatureFor, buildRepairRecipe, tagsForGenerator } from './learned-repair.js';
import { findOpenRecommendation, closeRecommendation } from '../../store/recommendations.js';

// Which real tag(s) a given generatorId's draft was meant to resolve, per
// source agent (the same generatorId can mean different things from different
// agents — e.g. 'faq' is produced by both opportunity and content-gap, with
// different checks). Derived from TAG_TO_GENERATOR/GAP_TYPE_TO_GENERATOR
// rather than hand-duplicated, so it can never drift from the real mapping
// each agent sets recommendedAction.generatorId from.
//
// The derivation moved to learned-repair.js because the cross-client reader
// needs the identical slugs to build the identical problem_signature — see
// tagsForGenerator's own comment. Importing it here rather than keeping a
// second copy is what makes "writer and reader agree" structural.

const CLOSED_STATUSES = new Set(['completed', 'no_longer_applicable']);

async function reopenIfClosed(siteId, watchlistItemId) {
  const item = await getWatchlistItemById(siteId, watchlistItemId);
  if (!item || !CLOSED_STATUSES.has(item.status)) return;
  await setWatchlistStatus(siteId, watchlistItemId, 'new',
    'Reopened — a fix verification re-checked the live page and found the issue still present.');
}

// Which real deterministic tags are still flagged for this row's exact
// generator, using whichever check function its source agent actually uses
// — opportunity's recommendationsFor (plain tag strings) or content-gap's
// contentGapsFor ({type, detail} objects). Rows with no recorded source
// (created before migration 037) fall back to the original opportunity-only
// behavior.
function currentTagsFor(row, analysis) {
  const tags = tagsForGenerator(row.generator_id, row.source);
  if (row.source === 'content-gap') {
    return { tags, tagsNow: contentGapsFor(analysis, row.query || '').map((g) => g.type) };
  }
  return { tags, tagsNow: recommendationsFor(analysis, row.query || '') };
}

// The primary automatic-LEARN trigger for the shared agent_fix_memory loop —
// no PR merge, no human, no Claude Code script required: a real re-fetch of
// the exact flagged page confirming the issue is actually gone (or isn't) is
// the strongest "did this fix really work" signal this app has, so it's what
// writes/updates memory. If this verification was checking the reuse of an
// EXISTING memory (row.memory_ref_id, set at draft-generation time — see
// routes/action-center.js's generateDraft), the outcome updates that
// specific row's reuse_history/confidence/status. Otherwise a
// 'verified-fixed' outcome is a genuinely NEW validated pattern, recorded as
// a fresh candidate memory for the next agent (any generator, any site) to
// find. A 'still-present' outcome with no prior memoryRefId has nothing
// established to downgrade — recordFixOutcome no-ops for that case (see its
// own comment) — there is no reusable "known bad fix" to warn future agents
// away from without a memoryRefId already anchoring one.
async function learnFromOutcome(row, outcome, tags) {
  try {
    if (row.memory_ref_id) {
      await recordFixOutcome({
        memoryRefId: row.memory_ref_id,
        outcome: outcome === 'verified-fixed' ? 'success' : 'failure',
        agentId: 'fix-verification', generatorId: row.generator_id, siteId: row.site_id,
        notes: `fix_verifications row ${row.id}, source=${row.source}`,
      });
      return;
    }
    if (outcome !== 'verified-fixed') return;

    // A live re-check confirming the issue is genuinely gone is the only
    // signal strong enough to justify letting this repair run on a DIFFERENT
    // client later, so this is the one write path that attaches a fingerprint
    // and a recipe. Both are best-effort: if the site row or its file mapping
    // can't be resolved, the memory is still written — it just stays
    // advisory-only (findPortableRepairs requires both to be non-null), which
    // is exactly today's behavior rather than a regression.
    const { fingerprint, recipe } = await portabilityFor(row).catch(() => ({ fingerprint: null, recipe: null }));

    await recordFixOutcome({
      category: topLevelCategoryForGenerator(row.generator_id), scope: 'client', siteId: row.site_id,
      generatorId: row.generator_id, outcome: 'success', sourceType: 'runtime-auto',
      problemSignature: problemSignatureFor(row.generator_id, tags, row.source),
      symptoms: `A ${row.generator_id} fix (source: ${row.source}) for tag(s) [${(tags || []).join(', ')}] was confirmed resolved on a real re-check of the live page.`,
      affectedPattern: `${row.generator_id} draft addressing tag(s): ${(tags || []).join(', ')}.`,
      fixStrategy: `See the implemented draft (id ${row.draft_id}) for the fix content that resolved this — re-run the same generator with the same approach for this tag pattern.`,
      siteFingerprint: fingerprint,
      repairRecipe: recipe,
    });
  } catch (err) {
    console.warn(`[fix-verification] agent_fix_memory write failed for row ${row.id}:`, err.message);
  }
}

// The technology context this fix was proven in, plus how to re-perform it.
// Returns nulls (not a throw) for a generator that may never run
// cross-client, or a site whose config can't answer the question — the
// resulting memory is then simply advisory, same as every row written today.
async function portabilityFor(row) {
  const recipe = buildRepairRecipe(row.generator_id);
  if (!recipe) return { fingerprint: null, recipe: null };

  const site = await getSiteById(row.site_id);
  if (!site) return { fingerprint: null, recipe: null };

  // Best-effort: getOrClassifyPageContentType never throws (fails open to
  // null internally), but this call site catches too so a classifier bug
  // can never turn a successful fix-verification into a failed one — the
  // worst case is just an unclassified fingerprint, which fingerprintCompatible
  // already refuses on rather than silently trusting.
  const contentType = await getOrClassifyPageContentType(row.site_id, row.page_url).catch(() => null);
  const fingerprint = computeSiteFingerprint(site, {
    targetFilePath: resolveFile(site, row.page_url),
    pageUrl: row.page_url,
    actionType: row.generator_id,
    contentType: contentType?.contentType || null,
  });
  // fingerprintCompatible refuses when a required token is absent, so a
  // fingerprint missing render:/target-ext:/page-adapter: could never match
  // anything anyway. Storing null instead makes that explicit in the data
  // rather than leaving a row that looks portable and silently never is.
  const hasRequired = ['render:', 'target-ext:', 'page-adapter:', 'content-type:'].every((prefix) =>
    fingerprint.some((t) => t.startsWith(prefix))
  );
  return hasRequired ? { fingerprint, recipe } : { fingerprint: null, recipe: null };
}

// analytics-install's own re-check: not a tag re-derivation (recommendation-
// sFor/contentGapsFor have no concept of "GA4/Pixel installed"), but a
// direct, literal check that the EXACT tracking ID this draft shipped —
// stashed in row.query at schedule time (see fix-verifications.js's
// isVerifiableDraft + drafts.js's markDraftImplemented) — now appears in the
// live page's real HTML. Closing the recommendation is gated on this outcome
// alone: a merged PR or an 'implemented' draft says only that the change was
// applied, never that it is actually live and working — this is the "did it
// really work" evidence the user-facing recommendation card is closed on.
async function verifyAnalyticsInstall(row) {
  const trackingId = row.query;
  const fetched = await fetchHtml(row.page_url);
  if (!fetched.ok) {
    await recordVerificationOutcome(row.id, 'unreachable', { error: fetched.error });
    return { id: row.id, outcome: 'unreachable' };
  }

  const installed = !!trackingId && fetched.html.includes(trackingId);
  const outcome = installed ? 'verified-fixed' : 'still-present';
  await recordVerificationOutcome(row.id, outcome, { trackingId, page: row.page_url });
  await learnFromOutcome(row, outcome, []);

  if (outcome === 'verified-fixed') {
    // The recommendation that originated this draft — same (site, page,
    // recommendationType) key trust-compliance.js's own finding uses, so
    // this is closing the actual row a human sees in the Action Center, not
    // a different one. findOpenRecommendation returns null if it was
    // already closed some other way (e.g. the slower closeStaleRecommend-
    // ations sweep beat this to it) — nothing to do in that case.
    const rec = await findOpenRecommendation(row.site_id, row.page_url, row.generator_id);
    if (rec) await closeRecommendation(rec.id);
  } else if (row.watchlist_item_id) {
    await reopenIfClosed(row.site_id, row.watchlist_item_id);
  }
  return { id: row.id, outcome };
}

// --------------------------------------------------------------------------
// Per-method evidence checks (migration 153)
// --------------------------------------------------------------------------
//
// Each returns { present: boolean|null, evidence } — `present: null` means the
// evidence could not be read at all (network failure, missing config), which
// is reported as 'unreachable' rather than being mistaken for a failed fix.
// None of these judge whether the shipped copy is *good*; they establish
// whether it is actually THERE, which is the question "did this ship" asks.

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&#8217;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function checkSiteAsset(row) {
  const fetched = await fetchTextIfExists(row.page_url);
  if (!fetched.ok) return { present: false, evidence: { asset: row.page_url, served: false } };
  const structure = row.expected?.structure;
  if (structure === 'llms-txt') {
    const valid = llmsTxtHasValidStructure(fetched.text);
    return { present: valid, evidence: { asset: row.page_url, served: true, validStructure: valid } };
  }
  return { present: true, evidence: { asset: row.page_url, served: true } };
}

async function checkResponseHeader(row) {
  const res = await fetchResponseHeaders(row.page_url);
  if (!res.ok) return { present: null, evidence: { error: res.error } };
  const wanted = row.expected?.headers || [];
  if (!wanted.length) return { present: null, evidence: { error: 'no header names were recorded for this change' } };
  const missing = wanted.filter((name) => !res.headers.get(name));
  return { present: missing.length === 0, evidence: { checked: wanted, missing } };
}

function duplicateIdsIn(html) {
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/gi)].map((m) => m[1]);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

async function checkPagePattern(row) {
  const fetched = await fetchHtml(row.page_url);
  if (!fetched.ok) return { present: null, evidence: { error: fetched.error } };
  const html = fetched.html;
  switch (row.expected?.check) {
    case 'html-lang-present': {
      const present = /<html[^>]*\slang=["'][^"']+["']/i.test(html);
      return { present, evidence: { check: 'html-lang-present' } };
    }
    case 'viewport-meta-present': {
      const present = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
      return { present, evidence: { check: 'viewport-meta-present' } };
    }
    case 'no-duplicate-ids': {
      const dupes = duplicateIdsIn(html);
      const target = row.expected?.id;
      const present = target ? !dupes.includes(target) : dupes.length === 0;
      return { present, evidence: { check: 'no-duplicate-ids', duplicatesFound: dupes.slice(0, 10), target: target ?? null } };
    }
    default:
      return { present: null, evidence: { error: `unknown pattern check "${row.expected?.check}"` } };
  }
}

async function checkPageAbsence(row) {
  const fetched = await fetchHtml(row.page_url);
  if (!fetched.ok) return { present: null, evidence: { error: fetched.error } };
  const absentTarget = row.expected?.absent;
  if (!absentTarget) return { present: null, evidence: { error: 'nothing was recorded as needing to be absent' } };
  const stillThere = fetched.html.includes(absentTarget);
  return { present: !stillThere, evidence: { mustBeAbsent: absentTarget, stillPresent: stillThere } };
}

async function checkRedirect(row) {
  const fetched = await fetchHtml(row.page_url);
  if (!fetched.ok) {
    // A 404 that is now correctly a 404 is not something this check can tell
    // apart from an unreachable host, so it stays honest and says so.
    return { present: null, evidence: { error: fetched.error } };
  }
  const landedElsewhere = !!fetched.url && fetched.url.replace(/\/$/, '') !== row.page_url.replace(/\/$/, '');
  return { present: landedElsewhere, evidence: { requested: row.page_url, landedOn: fetched.url ?? null, expected: row.expected?.to ?? null } };
}

async function checkPageContent(row) {
  const fetched = await fetchHtml(row.page_url);
  if (!fetched.ok) return { present: null, evidence: { error: fetched.error } };
  const needle = row.expected?.needle;
  if (!needle) return { present: null, evidence: { error: 'no excerpt was recorded to look for' } };
  const wanted = needle.replace(/\s+/g, ' ').trim().toLowerCase();
  // Checked against BOTH the visible text and the raw markup: plenty of real
  // shipped content never appears as visible text — JSON-LD inside a
  // <script type="application/ld+json">, an alt attribute, an OG meta tag —
  // and tag-stripping alone would report those as missing when they are
  // sitting right there.
  const visibleText = stripHtmlToText(fetched.html).toLowerCase();
  const rawMarkup = fetched.html.replace(/\s+/g, ' ').toLowerCase();
  const present = visibleText.includes(wanted) || rawMarkup.includes(wanted);
  return { present, evidence: { needle, page: row.page_url, foundIn: present ? (visibleText.includes(wanted) ? 'text' : 'markup') : null } };
}

// The merged branch is the evidence for changes with no public URL (a blog
// image swap, a new file whose route this app cannot resolve). It proves the
// change landed, and deliberately claims nothing about it being live — which
// is exactly why the deployment record is tracked separately.
async function checkRepoFile(row, site) {
  const files = row.expected?.files || [];
  if (!site?.repo_owner || !files.length) {
    return { present: null, evidence: { error: 'no repository or file path recorded for this change' } };
  }
  const needle = row.expected?.needle;
  for (const path of files) {
    const file = await getFileContent(site, path).catch((err) => ({ error: err.message }));
    if (file?.error) return { present: null, evidence: { error: file.error, path } };
    const content = typeof file === 'string' ? file : file?.content ?? '';
    if (!content) return { present: false, evidence: { path, reason: 'file is absent or empty in the merged branch' } };
    if (needle && !content.replace(/\s+/g, ' ').toLowerCase().includes(needle.replace(/\s+/g, ' ').trim().toLowerCase())) {
      return { present: false, evidence: { path, reason: 'file exists but no longer contains the shipped content' } };
    }
  }
  return { present: true, evidence: { files } };
}

async function runMethodCheck(row, site) {
  switch (row.method) {
    case VERIFICATION_METHOD.SITE_ASSET: return checkSiteAsset(row);
    case VERIFICATION_METHOD.RESPONSE_HEADER: return checkResponseHeader(row);
    case VERIFICATION_METHOD.PAGE_PATTERN: return checkPagePattern(row);
    case VERIFICATION_METHOD.PAGE_ABSENCE: return checkPageAbsence(row);
    case VERIFICATION_METHOD.REDIRECT: return checkRedirect(row);
    case VERIFICATION_METHOD.PAGE_CONTENT: return checkPageContent(row);
    case VERIFICATION_METHOD.REPO_FILE: return checkRepoFile(row, site);
    default: return { present: null, evidence: { error: `no verification method recorded (${row.method ?? 'null'})` } };
  }
}

// A fix that verified as still-broken is not finished work. Rather than
// leaving the recommendation closed and the finding silently marked done, put
// it back on the board with the real reason attached, so the next cycle can
// pick it up. Idempotent and per-site: reopenRecommendation no-ops on a row
// that is already open, and every lookup is scoped by site_id.
// The two ways a verification can fail mean opposite things, so they are
// classified rather than both falling through to classifyAbandonReason's
// "unrecognised prose => the item is defective" default:
//
//   NOT_LIVE   — the fix merged fine and simply never reached the site. The
//                item is not at fault and regenerating it would change
//                nothing; a person needs to look at why the merge did not
//                deploy. NEEDS_HUMAN, so it is not silently retried forever.
//   NOT_FIXED  — the change IS live and the issue is still there, so the
//                generated fix genuinely did not work. That is an item
//                defect, and counting it toward the convergence cap is the
//                point: a fix that keeps not working must eventually stop.
const RECONCILE = {
  NOT_LIVE: {
    reason: 'verification-found-change-not-live',
    failureClass: FAILURE_CLASS.CLIENT_REPO,
    retryPolicy: RETRY_POLICY.NEEDS_HUMAN,
  },
  NOT_FIXED: {
    reason: 'verification-found-issue-still-present',
    failureClass: FAILURE_CLASS.AGENT_LOGIC,
    retryPolicy: RETRY_POLICY.ITEM_DEFECT,
  },
};

async function reconcileFailedVerification(row, kind, evidence) {
  try {
    const rec = await findOpenRecommendation(row.site_id, row.page_url, row.generator_id);
    if (rec?.id) await reopenRecommendation(rec.id);
    await recordAttempt(row.site_id, {
      recommendationId: rec?.id ?? null,
      findingId: row.finding_id,
      draftId: row.draft_id ?? null,
      outcome: 'failed',
      reason: `${kind.reason}: ${JSON.stringify(evidence ?? {}).slice(0, 300)}`,
      failureClass: kind.failureClass,
      retryPolicy: kind.retryPolicy,
    });
  } catch (err) {
    console.warn(`[fix-verification] reconcile failed for row ${row.id}:`, err.message);
  }
  if (row.watchlist_item_id) await reopenIfClosed(row.site_id, row.watchlist_item_id);
}

// Was this change's merge ever actually deployed? Absence of the shipped
// evidence means two very different things depending on the answer, so the
// deployment record is consulted before an absence is called a failure.
async function resolveDeploymentState(row) {
  if (!row.deployment_id) return { known: false, deployment: null, graceElapsed: true };
  const deployment = await getDeploymentById(row.deployment_id);
  if (!deployment) return { known: false, deployment: null, graceElapsed: true };
  return { known: true, deployment, graceElapsed: deploymentGraceElapsed(deployment) };
}

const AWAIT_RECHECK_HOURS = Number(process.env.FIX_VERIFY_REDEPLOY_HOURS) || 3;

async function verifyByMethod(row, site) {
  const { present, evidence } = await runMethodCheck(row, site);

  if (present === null) {
    await recordVerificationOutcome(row.id, 'unreachable', evidence);
    return { id: row.id, outcome: 'unreachable' };
  }

  if (present) {
    const { deployment } = await resolveDeploymentState(row);
    // The live site reflecting the shipped change IS the deploy signal — this
    // is the only thing that promotes a deployment out of 'pending'.
    if (deployment && row.method !== VERIFICATION_METHOD.REPO_FILE) {
      await markDeploymentDetected(deployment.id, { via: row.method, verificationId: row.id, ...evidence });
    }
    await recordVerificationOutcome(row.id, 'verified-fixed', evidence);
    await learnFromOutcome(row, 'verified-fixed', []);
    const rec = await findOpenRecommendation(row.site_id, row.page_url, row.generator_id);
    if (rec) await closeRecommendation(rec.id);
    return { id: row.id, outcome: 'verified-fixed' };
  }

  // Absent. Still deploying, or genuinely not shipped?
  const { deployment, graceElapsed } = await resolveDeploymentState(row);
  if (deployment && !graceElapsed) {
    await rescheduleVerification(row.id, { delayHours: AWAIT_RECHECK_HOURS, evidence: { ...evidence, awaitingDeployment: true, commitSha: deployment.commit_sha } });
    return { id: row.id, outcome: 'awaiting-deployment' };
  }
  if (deployment && graceElapsed && deployment.status === 'pending') {
    await markDeploymentNotDetected(deployment.id, { reason: 'the merged change never appeared on the live site within the grace window', verificationId: row.id });
  }

  await recordVerificationOutcome(row.id, 'still-present', evidence);
  await learnFromOutcome(row, 'still-present', []);
  // A deployment we watched and never saw land is a deploy problem; anything
  // else means the change is live and the fix simply did not work.
  const neverDeployed = !!deployment && deployment.status !== 'deployed';
  await reconcileFailedVerification(row, neverDeployed ? RECONCILE.NOT_LIVE : RECONCILE.NOT_FIXED, evidence);
  return { id: row.id, outcome: 'still-present' };
}

async function verifyOne(row, site) {
  if (row.generator_id === 'analytics-install') return verifyAnalyticsInstall(row);
  // Rows scheduled by the wider coverage layer carry an explicit method.
  if (row.method && row.method !== VERIFICATION_METHOD.TAG_RECHECK) return verifyByMethod(row, site);

  const fetched = await analyzePageUrl(row.page_url);
  if (!fetched.ok) {
    await recordVerificationOutcome(row.id, 'unreachable', { error: fetched.error });
    return { id: row.id, outcome: 'unreachable' };
  }

  const { tags, tagsNow } = currentTagsFor(row, fetched.analysis);
  const stillFlagged = tags.some((t) => tagsNow.includes(t));

  if (stillFlagged) {
    // Same deploy-aware distinction the method verifiers make: a fix that is
    // merged but not yet live must not be recorded as a failed fix.
    const { deployment, graceElapsed } = await resolveDeploymentState(row);
    if (deployment && !graceElapsed) {
      await rescheduleVerification(row.id, { delayHours: AWAIT_RECHECK_HOURS, evidence: { tagsChecked: tags, tagsNow, awaitingDeployment: true } });
      return { id: row.id, outcome: 'awaiting-deployment' };
    }
    if (deployment && graceElapsed && deployment.status === 'pending') {
      await markDeploymentNotDetected(deployment.id, { reason: 'the merged change never appeared on the live site within the grace window', verificationId: row.id });
    }
  } else {
    const { deployment } = await resolveDeploymentState(row);
    if (deployment) await markDeploymentDetected(deployment.id, { via: 'tag-recheck', verificationId: row.id });
  }

  const outcome = stillFlagged ? 'still-present' : 'verified-fixed';
  await recordVerificationOutcome(row.id, outcome, { tagsChecked: tags, tagsNow });
  await learnFromOutcome(row, outcome, tags);

  if (outcome === 'still-present') {
    await reconcileFailedVerification(row, RECONCILE.NOT_FIXED, { tagsChecked: tags, tagsNow });
  }
  return { id: row.id, outcome };
}

// Re-fetches the EXACT flagged page and re-runs the EXACT deterministic
// check that originally flagged it (recommendationsFor for opportunity,
// contentGapsFor for content-gap — see currentTagsFor) — real evidence, not
// a hope the page resurfaces in some agent's next rotation batch. Runs
// across all sites in one pass; due-ness is per-row (verify_after), so
// there's no per-site "is it due" wrapper here (see server/job.js).
export async function runDueVerifications() {
  const due = await getDueVerifications();
  const results = [];
  // One site row per site per pass, not per verification — a batch PR routinely
  // produces many due rows for the same tenant.
  const siteCache = new Map();
  for (const row of due) {
    try {
      if (!siteCache.has(row.site_id)) {
        siteCache.set(row.site_id, await getSiteById(row.site_id).catch(() => null));
      }
      results.push(await verifyOne(row, siteCache.get(row.site_id)));
    } catch (err) {
      console.warn(`[fix-verification] row ${row.id} failed:`, err.message);
    }
  }
  return results;
}
