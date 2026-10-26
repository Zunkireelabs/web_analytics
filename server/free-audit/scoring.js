function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function scoreCategory(checks, category) {
  const relevant = checks.filter((c) => c.category === category && c.maxScore > 0);
  const earned = relevant.reduce((sum, c) => sum + c.score, 0);
  const possible = relevant.reduce((sum, c) => sum + c.maxScore, 0);
  const score = possible > 0 ? Math.round((100 * earned) / possible) : 0;
  return { score, grade: gradeFor(score) };
}

function scoreAll(checks) {
  return {
    seo: scoreCategory(checks, 'seo'),
    aeo: scoreCategory(checks, 'aeo'),
    agentic: scoreCategory(checks, 'agentic'),
    geo: scoreCategory(checks, 'geo'),
  };
}

export { scoreAll, gradeFor };
