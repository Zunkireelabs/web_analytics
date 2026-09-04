import { getSiteById, getQueriesForPage } from '../../store/read.js';
import { hasAnyFaqDraftEver } from '../../store/drafts.js';
import { knownDomain } from './site-domain.js';
import { analyzePageUrl, fetchHtml } from './page-content.js';
import { hasOrganicFaqSignal } from '../../lib/faq-signal.js';
import { findOpenRecommendation, insertRecommendation } from '../../store/recommendations.js';
import { riskTierForGenerator } from './risk-tiers.js';
import { impactFromPriority } from './findings.js';

// "For a NEW CLIENT, when they come in, if they don't have an FAQ, generate
// one that blends with their site" — the proactive half of FAQ coverage.
// Everything that already exists (faq.js the generator, faq-signal.js the
// organic-content detector, the visible-FAQ cap) is REACTIVE: it only acts
// once something else — a human, an AI-visibility finding, a keyword gap —
// already decided a specific page needs an FAQ. Nothing ever asked "does
// this site have ANY FAQ coverage at all?" on its own. This module is that
// one question, checked once per site per day, alongside every other
// onboarding-adjacent daily pass (see job.js).
//
// Three real signals, checked cheapest-first, any one of which means "this
// site already has FAQ coverage, do nothing":
//   1. site.visible_faq_baseline > 0 — a human already ran "Recalculate FAQ
//      baseline" and found real organic FAQ content before this tool ever
//      touched the site.
//   2. hasAnyFaqDraftEver — this tool itself already shipped one (visible
//      OR schema-only), on ANY page.
//   3. A live fetch of the homepage's real HTML shows an organic FAQ
//      pattern (faq-signal.js) — catches the "new client, but their site
//      already has a hand-authored FAQ this tool has simply never touched"
//      case, which 1 and 2 alone would both miss.
//
// Only when ALL THREE come back empty does this create a recommendation —
// and even then it creates exactly ONE, grounded in the homepage's own real
// content, through the exact same `faq` generator/risk-tier/gate path every
// other FAQ recommendation already goes through. No new generator, no new
// autonomy path.
export async function checkFaqOnboardingCoverage(siteId, { site: siteArg } = {}) {
  const site = siteArg || await getSiteById(siteId);
  if (!site?.repo_owner || !site?.repo_name) return { checked: false, reason: 'no-repo' };

  if ((site.visible_faq_baseline || 0) > 0) return { checked: true, hasFaq: true, reason: 'baseline' };
  if (await hasAnyFaqDraftEver(siteId)) return { checked: true, hasFaq: true, reason: 'already-shipped' };

  const domain = knownDomain(site);
  if (!domain) return { checked: false, reason: 'no-known-domain' };
  const homepage = `https://${domain}/`;

  // Raw HTML (not the stripped/extracted text analyzePageUrl below returns)
  // — hasOrganicFaqSignal's patterns match real markup (a Nunjucks/Vue/React
  // loop, an accordion class name), which a plain-text extraction would
  // never contain.
  const rawFetch = await fetchHtml(homepage).catch((err) => ({ ok: false, error: err.message }));
  if (!rawFetch.ok) return { checked: false, reason: 'homepage-unreachable', error: rawFetch.error };
  if (hasOrganicFaqSignal(rawFetch.html)) return { checked: true, hasFaq: true, reason: 'organic-signal-on-homepage' };

  const fetched = await analyzePageUrl(homepage).catch((err) => ({ ok: false, error: err.message }));
  if (!fetched.ok) return { checked: false, reason: 'homepage-unreachable', error: fetched.error };

  // No FAQ signal anywhere real this check can see. Ground the new FAQ's
  // subject in whatever real evidence exists for the homepage — a real top
  // GSC query when the site has search history, falling back to the
  // homepage's own real <title> text (never an invented topic) for a
  // genuinely brand-new client with no GSC data yet.
  const topQueries = await getQueriesForPage(siteId, isoDaysAgo(90), isoToday(), homepage, 1).catch(() => []);
  const query = topQueries[0]?.query || null;
  const topic = query ? null : (fetched.analysis?.title || null);
  if (!query && !topic) return { checked: true, hasFaq: false, created: false, reason: 'no-groundable-subject' };

  const params = { page: homepage, ...(query ? { query } : { topic }) };
  // recommendation-coordinator.js's recommendationPageKey falls through to
  // `params.page` for the 'faq' generatorId specifically (it has no special
  // case of its own) — inlined here rather than imported to avoid pulling
  // that module's much heavier dependency graph (runner.js -> every agent)
  // into this small, frequently-run daily check for one pure fallback line.
  const page = homepage;
  const existing = await findOpenRecommendation(siteId, page, 'faq');
  if (existing) return { checked: true, hasFaq: false, created: false, reason: 'already-recommended' };

  await insertRecommendation(siteId, {
    page,
    recommendationType: 'faq',
    issue: 'No FAQ content found anywhere on this site — generating one for the homepage',
    reason: `This site has no FAQ/Q&A content this tool can find (no tool-shipped FAQ, no organic FAQ detected on ${homepage}, no recorded baseline). A homepage FAQ grounded in ${query ? `the real query "${query}"` : `the page's own title "${topic}"`} closes the gap using the site's own current design (the \`faq\` generator projects off the stored design profile, same as every other FAQ it drafts).`,
    params,
    findingId: `faq-onboarding:${siteId}:${homepage}`,
    detectingAgent: 'faq-onboarding-check',
    priority: 'medium',
    riskTier: riskTierForGenerator('faq'),
    expectedImpact: { label: impactFromPriority('medium'), basis: 'estimate', value: null },
  });
  return { checked: true, hasFaq: false, created: true };
}

function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function checkFaqOnboardingCoverageForAllSites() {
  const { listConnectedSites } = await import('../../job.js');
  const sites = await listConnectedSites();
  const totals = { sites: 0, created: 0 };
  for (const site of sites) {
    try {
      const result = await checkFaqOnboardingCoverage(site.id, { site });
      totals.sites++;
      if (result.created) {
        totals.created++;
        console.log(`[faq-onboarding-check] site ${site.id} "${site.name}": no FAQ coverage found anywhere — created a homepage FAQ recommendation.`);
      }
    } catch (err) {
      console.error(`[faq-onboarding-check] site ${site.id} "${site.name}" failed:`, err.message);
    }
  }
  return totals;
}
