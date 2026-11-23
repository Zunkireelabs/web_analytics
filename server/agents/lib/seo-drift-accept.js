import { getRecommendationById, dismissRecommendation } from '../../store/recommendations.js';
import { acceptLatestAsBaseline } from '../../store/seo-snapshots.js';

// "This change to the page is intended." The page's latest capture becomes its baseline, so it is compared against the page as it
// is now from here on, and the recommendation that raised the change is closed as dismissed (a person's decision, not a fix). If
// the page later changes again in a way that matters, a fresh recommendation opens.
//
// Scoped to the caller's own project at both reads: the recommendation is looked up by (site, id), and the baseline by (site, url).
// Errors carry .status so the route can answer with the right HTTP code.
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function acceptDriftChange(siteId, recommendationId, deps = {}) {
  const d = { getRecommendationById, dismissRecommendation, acceptLatestAsBaseline, ...deps };
  const rec = await d.getRecommendationById(siteId, recommendationId);
  if (!rec) throw fail(404, 'Recommendation not found');
  if (rec.recommendation_type !== 'seo-drift') throw fail(400, 'Only a change to a live page can be marked as intended.');
  if (rec.status !== 'open') return { status: rec.status, changed: false };
  const page = rec.params?.page;
  if (!page) throw fail(409, 'This change has no page on record.');

  const baseline = await d.acceptLatestAsBaseline(siteId, page);
  if (!baseline) throw fail(409, 'There is no saved copy of this page to accept yet. It will be captured on the next check.');
  await d.dismissRecommendation(rec.id);
  return { status: 'dismissed', changed: true, page, acceptedAt: baseline.capturedAt };
}
