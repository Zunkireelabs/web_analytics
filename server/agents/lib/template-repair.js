import { getSiteById } from '../../store/read.js';
import {
  COMPONENT_TEMPLATE_KEY, isTemplateVerified, verifyTemplateAgainstLiveSite, sitePageUrl, fetchText,
} from '../../implementers/lib/design-drift.js';
import { updateSiteRepoConfig } from '../../db.js';
import { recordAuditEvent } from '../../store/admin/audit-log.js';

// Verifies a site's existing-but-unstamped component templates against its
// real live CSS, and stamps the ones that pass.
//
// This exists because of WHERE the two halves of the design gate run.
// resolveOrCreateComponentTemplate can self-heal a template, but it is only
// reached inside generateDraft — by which point the recommendation list has
// already been built and every affected row is showing as blocked. The
// recommendation gate itself (recommendation-gates.js ->
// componentTemplateVerification) is deliberately pure and in-memory, so it
// cannot do any verifying of its own. A stamp landing at draft time therefore
// never unblocks the list in the same run; the user sees "blocked" until the
// next day's sync.
//
// So the repair runs once per site, up front, before buildRecommendations —
// and the whole list is honest on the first pass.
//
// Cost is bounded and small: one page fetch plus its stylesheets per site,
// shared across all five component keys, because every template on a site
// links the same CSS bundle. Fetching per key would multiply that by five for
// no new information.

// A verified template's stamp used to mean "verified, permanently" — the
// loop below only ever re-checked templates with NO stamp at all
// (isTemplateVerified's 'unverified' reason), skipping every already-
// verified one forever after. verifyTemplateAgainstLiveSite's structural
// check (checkTemplateStructuralMatch, added 2026-09-10 for exactly this
// class of incident) DOES catch a component whose real DOM shape changed
// even though its classes still resolve — but only the day it's captured,
// never again, since a passing template is never handed back to it. A real
// client redesign between then and now could change a component's shape
// with its old class names still live in the new CSS (real, not
// hypothetical — utility classes get reused across unrelated components
// constantly) and nothing here would ever notice.
//
// This whole file already runs once a day (runTemplateCapabilityRepairForAllSites,
// cron.js) — a live client site drifting is exactly the kind of thing a
// production tenant can't afford to sit undetected for a week, so the
// re-verification window matches that same daily cadence rather than the
// slower 7-day cycle queueDesignProfileRescanForAllSites uses for its own,
// lower-stakes "is our captured snapshot still real" question. One extra
// page-plus-stylesheet fetch per site per day for an already-verified
// template is a cheap, worthwhile trade for catching a real design break
// the morning it happens instead of up to a week later.
const REVERIFY_AFTER_MS = 24 * 60 * 60 * 1000;

function needsReverification(actionType, template) {
  const verdict = isTemplateVerified(actionType, template);
  if (verdict.reason === 'unverified') return true;
  if (!verdict.ok) return false; // 'missing'/'invalid-placeholders' — not this function's job to fix
  return Date.now() - new Date(verdict.verifiedAt).getTime() > REVERIFY_AFTER_MS;
}

// The CSS a site links is the same on every page, so the first fetch answers
// for all five templates. Scoped per call rather than module-level: a
// long-lived cache would happily verify against a stylesheet that shipped
// weeks ago, which is precisely the staleness this check exists to catch.
function makeSharedPageCache() {
  const pages = new Map();
  const sheets = new Map();
  const fetchOnce = (cache, fn) => async (url) => {
    if (!cache.has(url)) cache.set(url, await fn(url));
    return cache.get(url);
  };
  return { pages, sheets, fetchOnce };
}

export async function repairSiteTemplates(siteId, {
  loadSite = getSiteById,
  saveConfig = updateSiteRepoConfig,
  recordAudit = recordAuditEvent,
  verifyFn = verifyTemplateAgainstLiveSite,
  fetchPage,
  fetchStylesheet,
  log = console,
} = {}) {
  const site = await loadSite(siteId);
  if (!site) return { verified: 0, stale: 0, unreachable: 0, skipped: 0, absent: 0 };

  const pageUrl = sitePageUrl(site);
  if (!pageUrl) return { verified: 0, stale: 0, unreachable: 0, skipped: 0, absent: 0, reason: 'no-live-url' };

  const templates = site.url_file_map?.siteRoot?.componentTemplates || {};
  // `absent` and `skipped` are kept apart deliberately: "this site has no faq
  // template at all" and "this site's faq template is already verified" are
  // different facts, and collapsing them makes the summary unreadable — a site
  // with one verified template out of five would report skipped:5 either way.
  const counts = { verified: 0, stale: 0, bodySlotIsLabel: 0, structuralMismatch: 0, unreachable: 0, skipped: 0, absent: 0, invalidated: 0 };

  // One shared fetch cache across every key checked in this pass.
  const cache = makeSharedPageCache();
  // The memo wraps whichever fetcher is in play, injected or default — it is a
  // property of this pass ("read each URL once"), not of the transport.
  const pageFetcher = cache.fetchOnce(cache.pages, fetchPage || fetchText);
  const sheetFetcher = cache.fetchOnce(cache.sheets, fetchStylesheet || fetchText);

  // Accumulated so all five keys are written in ONE saveConfig rather than
  // five racing read-modify-writes against the same JSONB column.
  let repaired = null;

  for (const [actionType, componentKey] of Object.entries(COMPONENT_TEMPLATE_KEY)) {
    const template = templates[componentKey];
    if (!template?.wrapper) { counts.absent++; continue; }
    const wasVerified = isTemplateVerified(actionType, template).ok;
    if (!needsReverification(actionType, template)) { counts.skipped++; continue; }

    const result = await verifyFn(actionType, template, { pageUrl, fetchPage: pageFetcher, fetchStylesheet: sheetFetcher })
      .catch((err) => ({ ok: false, reason: 'unreachable', error: err.message }));

    if (result.ok) {
      repaired = { ...(repaired || templates), [componentKey]: result.stamped };
      counts.verified++;
      log.log(`[template-repair] site ${siteId}: ${componentKey} verified against live CSS (${result.checkedClasses?.length ?? 0} classes) — unblocking its recommendations.`);
      continue;
    }

    // A real defect (not a network blip): 'stale', 'body-slot-is-label', and
    // 'structural-mismatch' (checkTemplateStructuralMatch, 2026-09-10 —
    // catches a component whose real DOM shape changed even though its old
    // classes are still live) all mean the check SUCCEEDED and found the
    // template no longer matches the real site. A previously-verified
    // template failing its periodic re-check must have its stamp cleared —
    // otherwise isTemplateVerified keeps trusting it and backend.js's real
    // per-draft gate (checkTemplateFreshness alone, no structural check —
    // see that function's own comment for why) has no way to know the
    // deeper check already disproved it.
    const isRealDefect = result.reason === 'stale' || result.reason === 'body-slot-is-label' || result.reason === 'structural-mismatch';
    if (isRealDefect && wasVerified) {
      repaired = { ...(repaired || templates), [componentKey]: { ...template, verifiedAt: null, verifiedBy: null, verifiedRef: null } };
      counts.invalidated++;
    }

    if (result.reason === 'stale') {
      counts.stale++;
      log.warn(`[template-repair] site ${siteId}: ${componentKey} claims class(es) the live site no longer ships (${(result.missingClasses || []).join(', ')}) — leaving it unverified for the Design Agent to re-derive.`);
    } else if (result.reason === 'body-slot-is-label') {
      // Counted and logged separately from 'unreachable' on purpose. The two
      // are opposites: 'unreachable' means the check learned nothing (a
      // network blip, retry next pass), while this means the check succeeded
      // and found a real defect an engineer should see. Bucketing it as
      // unreachable made a genuine design-drift finding indistinguishable
      // from a timeout, and silent — this branch logged nothing at all.
      counts.bodySlotIsLabel++;
      log.warn(`[template-repair] site ${siteId}: ${componentKey} styles its body slot as a label — ${result.error} Leaving it unverified; the site's design profile needs re-deriving.`);
    } else if (result.reason === 'structural-mismatch') {
      // Same "not unreachable" reasoning as body-slot-is-label above — this
      // used to fall into the generic else branch and get silently counted
      // as a timeout. It's the opposite: a real, confirmed shape mismatch.
      counts.structuralMismatch++;
      log.warn(`[template-repair] site ${siteId}: ${componentKey}'s captured shape no longer matches the live site (${result.error}) — leaving it unverified for the Design Agent to re-derive.`);
    } else {
      counts.unreachable++;
    }
  }

  if (repaired) {
    const urlFileMap = {
      ...site.url_file_map,
      siteRoot: { ...site.url_file_map?.siteRoot, componentTemplates: repaired },
    };
    await saveConfig({ siteId: site.id, urlFileMap });
    // Same synthetic actor shape design-drift.js uses: this runs on a
    // schedule, not from a staff HTTP request, and a null userId resolves to
    // audit-log.js's 'system' actor — the right attribution for a stamp no
    // human clicked to create.
    await recordAudit({ userId: null, siteId: site.id, ip: null, get: () => null }, {
      action: 'tenant.component_templates_freshness_verified',
      targetType: 'site',
      targetId: String(site.id),
      tenantSiteId: site.id,
      tenantName: site.name,
      metadata: { verified: counts.verified, stale: counts.stale, bodySlotIsLabel: counts.bodySlotIsLabel, structuralMismatch: counts.structuralMismatch, invalidated: counts.invalidated, pageUrl },
      success: true,
    }).catch(() => {});
  }

  return counts;
}
