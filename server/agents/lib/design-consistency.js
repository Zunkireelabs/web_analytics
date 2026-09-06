import { findOpenRecommendation, insertRecommendation } from '../../store/recommendations.js';
import { impactFromPriority } from './findings.js';

// Turns consistency-check.js's real, section-level findings into real
// Action Center recommendations — the same table, same gates-free insert
// path every other DETECTION-only (no generator) finding in this app uses.
//
// 'design-consistency-review' is a PSEUDO recommendation_type, same
// precedent as analyst-seo-mapping.js's 'comparison-page': there is no
// generator that can safely rewrite an arbitrary section's markup (there is
// no known-correct template the way a marker region has one), so this is
// deliberately NOT wired to riskTierForGenerator (which would return
// 'manual' anyway for an unrecognized id, but explicitly stating it here
// makes the "no generator exists for this yet" fact readable at the call
// site, not just an accident of a lookup miss).
//
// ONE recommendation per PAGE, not per finding — a page can have several
// drifted sections, and five near-identical rows for one page would spam
// the Action Center for what a human will review as a single "this page
// needs a look" unit anyway. All the individual findings stay visible in
// the row's own reason text.
export async function persistConsistencyFindings(siteId, findings) {
  const byPage = new Map();
  for (const f of findings || []) {
    if (!byPage.has(f.pageUrl)) byPage.set(f.pageUrl, []);
    byPage.get(f.pageUrl).push(f);
  }

  let created = 0;
  let skipped = 0;
  for (const [pageUrl, pageFindings] of byPage) {
    const findingId = `design-consistency:${pageUrl}`;
    const existing = await findOpenRecommendation(siteId, pageUrl, 'design-consistency-review');
    if (existing) { skipped++; continue; }

    const byKind = {};
    for (const f of pageFindings) byKind[f.id] = (byKind[f.id] || 0) + 1;
    const summary = Object.entries(byKind).map(([kind, n]) => `${n}× ${kind}`).join(', ');
    const detail = pageFindings.slice(0, 5).map((f) =>
      `- [${f.sectionRole}] ${f.id}: ${JSON.stringify(f.evidence)}`
    ).join('\n');

    await insertRecommendation(siteId, {
      page: pageUrl,
      recommendationType: 'design-consistency-review',
      issue: `${pageFindings.length} section(s) on this page don't match the site's own real design conventions (${summary})`,
      reason: `A whole-page design-consistency scan (not just SEOAI-marker regions) found real, evidenced drift — every section's classes are compared against this site's own stored design profile, never invented. No generator exists yet that can safely rewrite an arbitrary section, so this needs a human look.\n\n${detail}`,
      params: { page: pageUrl, findings: pageFindings },
      findingId,
      detectingAgent: 'design-consistency',
      priority: pageFindings.length >= 3 ? 'high' : 'medium',
      riskTier: 'manual',
      expectedImpact: { label: impactFromPriority(pageFindings.length >= 3 ? 'high' : 'medium'), basis: 'estimate', value: null },
    });
    created++;
  }
  return { created, skipped, pagesWithFindings: byPage.size };
}
