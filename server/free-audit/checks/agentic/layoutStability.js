export default function layoutStability({ render }) {
  const { available, cls } = render || { available: false, cls: null };

  if (!available) {
    return {
      id: 'layout-stability',
      title: 'Layout Stability (CLS)',
      category: 'agentic',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Playwright is not installed — this check was skipped.',
      recommendation: 'Install the optional "playwright" package to enable this check.',
    };
  }

  if (cls === null || cls === undefined) {
    return {
      id: 'layout-stability',
      title: 'Layout Stability (CLS)',
      category: 'agentic',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'Could not measure layout shift for this page.',
      recommendation: 'No action needed.',
    };
  }

  const pass = cls <= 0.1;

  return {
    id: 'layout-stability',
    title: 'Layout Stability (CLS)',
    category: 'agentic',
    passed: pass,
    score: pass ? 1 : 0,
    maxScore: 1,
    message: `Cumulative Layout Shift measured at ${cls.toFixed(3)} (target ≤ 0.100).`,
    recommendation: pass
      ? 'No action needed.'
      : 'Reduce layout shifts (reserve space for images/ads, avoid late-injected content above the fold) — a shifting layout can cause an AI agent to click the wrong element, the same way it disrupts human users.',
  };
};
