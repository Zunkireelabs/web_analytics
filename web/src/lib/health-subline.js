// The caption under the Overall health score: where it is being lost, in words, from health.breakdown (server: buildHealthBreakdown,
// same formula as the score). Falls back to the old caption when there is nothing to say (no findings, or an older server).
const LABEL = { security: 'Security', seo: 'SEO', technical: 'Technical SEO', performance: 'Speed', accessibility: 'Accessibility', content: 'Content', 'on-page': 'On-page', geo: 'GEO', other: 'Other' };
const FALLBACK = 'Weighted across all agents';

export function healthSubline(health) {
  const rows = Array.isArray(health?.breakdown) ? health.breakdown : [];
  if (!rows.length) return FALLBACK;
  const top = rows[0];
  const pct = Math.round((Number(top.share) || 0) * 100);
  const name = LABEL[top.category] || top.category;
  if (rows.length === 1 || pct < 1) return `Open issues are all in ${name}`;
  return `${pct}% of the loss is in ${name}`;
}
