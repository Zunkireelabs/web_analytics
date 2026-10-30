const MAX_RESOURCES = 80;

export default function resourceBreakdown({ render }) {
  if (!render || !render.available || !render.resources) {
    return {
      id: 'resource-breakdown',
      title: 'Resources Breakdown',
      category: 'seo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Resources were not measured — enable JS render mode to check this.',
      recommendation: 'No action needed.',
    };
  }

  const { count, bytes, byType } = render.resources;
  const ok = count <= MAX_RESOURCES;
  const kb = Math.round(bytes / 1024);
  const breakdown = Object.entries(byType)
    .map(([type, n]) => `${type}: ${n}`)
    .join(', ');

  return {
    id: 'resource-breakdown',
    title: 'Resources Breakdown',
    category: 'seo',
    passed: ok,
    score: ok ? 3 : 0,
    maxScore: 3,
    message: `${count} resources loaded (${kb}KB total)${breakdown ? ` — ${breakdown}` : ''}.`,
    recommendation: ok
      ? 'No action needed.'
      : `This page loads more than ${MAX_RESOURCES} resources — consider bundling, lazy-loading, or removing unused assets.`,
  };
};
