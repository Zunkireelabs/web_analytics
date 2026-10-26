import { fixFor } from './fixes.js';

const FREE_ISSUES = 3;

function severity(lost) {
  return lost >= 8 ? 'High' : lost >= 4 ? 'Medium' : 'Low';
}

function summarise(report) {
  const scored = report.checks.filter((c) => c.maxScore > 0);
  const failing = scored
    .filter((c) => c.score < c.maxScore)
    .map((c) => ({ ...c, severity: severity(c.maxScore - c.score) }))
    .sort((a, b) => (b.maxScore - b.score) - (a.maxScore - a.score));
  const passed = scored
    .filter((c) => c.score >= c.maxScore)
    .map((c) => ({ id: c.id, title: c.title, category: c.category, message: c.message }));
  return { scored, failing, passed };
}

// What a visitor sees before giving an email: overall scores, the top issues in
// full, one free sample fix, and only titles for the rest.
function buildTeaser(report, id) {
  const { scored, failing, passed } = summarise(report);
  const pick = (c) => ({ id: c.id, title: c.title, category: c.category, severity: c.severity, message: c.message });
  // Free sample: the fix that needs the fewest REPLACE placeholders (most real, least to fill in).
  const placeholders = (fix) => (fix.code.match(/REPLACE/g) || []).length;
  const sample = failing.map((c) => ({ c, fix: fixFor(c, report) })).filter((x) => x.fix)
    .sort((a, b) => placeholders(a.fix) - placeholders(b.fix))[0];
  return {
    id,
    finalUrl: report.finalUrl,
    overall: report.overall,
    pageMetadata: { title: report.pageMetadata?.title ?? null, description: report.pageMetadata?.description ?? null },
    counts: { total: scored.length, passed: scored.length - failing.length, failing: failing.length },
    passed,
    issues: failing.map((c, i) => (i < FREE_ISSUES ? pick(c) : { id: c.id, title: c.title, category: c.category, severity: c.severity, locked: true })),
    sampleFix: sample ? { checkId: sample.c.id, checkTitle: sample.c.title, ...sample.fix } : null,
  };
}

// The unlocked report: every issue, with the generated fix where we have one.
function buildFullReport(report) {
  const { scored, failing, passed } = summarise(report);
  return {
    finalUrl: report.finalUrl,
    fetchedAt: report.fetchedAt,
    overall: report.overall,
    pageMetadata: { title: report.pageMetadata?.title ?? null, description: report.pageMetadata?.description ?? null },
    counts: { total: scored.length, passed: scored.length - failing.length, failing: failing.length },
    passed,
    issues: failing.map((c) => ({ id: c.id, title: c.title, category: c.category, severity: c.severity, message: c.message, recommendation: c.recommendation, fix: fixFor(c, report) })),
  };
}

export { buildTeaser, buildFullReport };
