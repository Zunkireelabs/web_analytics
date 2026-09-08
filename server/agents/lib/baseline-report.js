import { getSiteById, getDailySeries, getHealthScoreOnOrBefore } from '../../store/read.js';
import { listOpenRecommendations } from '../../store/recommendations.js';
import { getLatestAuditRun, getAuditPageFindings } from '../../store/audit-runs.js';
import { saveBaselineReport } from '../../store/baseline-reports.js';
import { callLLM } from '../../llm.js';

// The client-facing "day 0" document (server/migrations/150_baseline_reports.sql):
// what the site's KPIs and open issues looked like at onboarding, so later
// Milestones progress can be told as a real before/after story instead of
// just a chart. Modeled on review-report.js's "bundle real facts, one
// callLLM narrative pass" shape, but client-facing tone (review-report.js is
// explicitly staff-only) and a flowing markdown document instead of fixed
// JSON sections, rendered client-side by MarkdownReport.jsx.
//
// Generated once at onboarding (runBaselineSequence, server/routes/clients.js)
// and on demand via the staff "Generate Now"/regenerate path — never
// recomputed automatically afterward, since its whole purpose is to freeze
// what day 0 looked like.
const KPI_WINDOW_DAYS = 30;
const AUDIT_FINDINGS_LIMIT = 500;

function summarizeKpiSnapshot(dailySeries, healthScore) {
  const withData = dailySeries.filter((d) => d.clicks != null || d.sessions != null);
  const sum = (key) => withData.reduce((total, d) => total + (Number(d[key]) || 0), 0);
  return {
    daysOfHistory: withData.length,
    windowDays: dailySeries.length,
    healthScore,
    clicks: sum('clicks'),
    impressions: sum('impressions'),
    sessions: sum('sessions'),
    users: sum('users'),
  };
}

function summarizeIssuesSnapshot(recommendations, auditRun, auditFindings) {
  const byPriority = { high: 0, medium: 0, low: 0 };
  for (const r of recommendations) byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
  return {
    openRecommendations: {
      total: recommendations.length,
      byPriority,
      items: recommendations.slice(0, 50).map((r) => ({
        page: r.page, type: r.recommendation_type, issue: r.issue, priority: r.priority,
      })),
    },
    fullSiteAudit: auditRun
      ? {
          available: true,
          status: auditRun.status,
          healthScore: auditRun.health_score,
          pagesAudited: auditRun.pages_audited,
          findingsCount: auditFindings.length,
        }
      : { available: false },
  };
}

// The onboarding audit (startFullSiteAudit's fire-and-forget crawl) usually
// hasn't finished by the time runBaselineSequence freezes the day-0 report,
// so it's common for the frozen narrative to say the audit "wasn't yet
// available." Called once from bulk-audit.js right after an
// triggeredBy: 'onboarding' run completes: if the site's frozen baseline
// still shows that gap, this fills it in with the now-real findings — the
// one deliberate exception to "never recomputed automatically afterward"
// above, since the audit that just finished IS day 0's audit, just late.
// A no-op once the baseline already has real audit data (manual re-audits
// weeks later must never overwrite the frozen day-0 snapshot).
export async function refreshBaselineReportIfPending(siteId) {
  const existing = await getBaselineReport(siteId);
  if (!existing) return null;
  const auditSnapshot = existing.issues_snapshot?.fullSiteAudit;
  // `available` only means "some audit_runs row existed to report on" — a
  // failed/reaped run still sets it true, so the real signal is status.
  if (auditSnapshot?.status === 'completed') return null;
  return buildBaselineReport(siteId);
}

export async function buildBaselineReport(siteId) {
  const site = await getSiteById(siteId);
  if (!site) return null;

  const today = new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.now() - KPI_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [dailySeries, healthScore, recommendations, auditRun] = await Promise.all([
    getDailySeries(siteId, windowStart, today),
    getHealthScoreOnOrBefore(siteId, today),
    listOpenRecommendations(siteId),
    getLatestAuditRun(siteId),
  ]);
  // Full site audit runs fire-and-forget alongside onboarding (see
  // runBaselineSequence) and can genuinely still be in progress when this
  // generates — that's fine, the same as review-report.js tolerating a
  // short health-score series: honestly reflect whatever exists right now
  // rather than blocking the baseline on a slow crawl finishing.
  const auditFindings = auditRun ? await getAuditPageFindings(auditRun.id, { limit: AUDIT_FINDINGS_LIMIT }) : [];

  const kpiSnapshot = summarizeKpiSnapshot(dailySeries, healthScore);
  const issuesSnapshot = summarizeIssuesSnapshot(recommendations, auditRun, auditFindings);

  const narrativeMd = await generateNarrative(site, kpiSnapshot, issuesSnapshot);
  return saveBaselineReport(siteId, { kpiSnapshot, issuesSnapshot, narrativeMd });
}

async function generateNarrative(site, kpiSnapshot, issuesSnapshot) {
  const system = 'You are a growth strategist writing a CLIENT-FACING Baseline Report — the very first document a ' +
    'new client sees, capturing exactly what their website looked like and what issues existed on the day they ' +
    'were onboarded. This document gets compared against later reports to show real growth, so accuracy matters ' +
    'more than optimism. You are given `kpiSnapshot` (real GSC/GA4 totals over the ' + KPI_WINDOW_DAYS + ' days ' +
    'before onboarding, and daysOfHistory — how many of those days actually had data; a brand-new site connection ' +
    'often has very little or zero history yet, say so plainly instead of implying an established trend) and ' +
    '`issuesSnapshot` (real open recommendations grouped by priority, and a full-site-audit summary that may show ' +
    'available: false if the audit crawl was still running when this was generated — say so honestly, never imply ' +
    'a completed audit that has not finished). Never invent a number not present in the data given to you.\n\n' +
    'Return ONLY a markdown document (no JSON, no code fences) with exactly these headings, in this order:\n' +
    '# Baseline Report — <site name> — <today\'s date>\n' +
    '## Where Your Website Stood\n' +
    '2-4 sentences on the real KPI starting point (clicks/impressions/sessions/health score), honest about how ' +
    'little history exists if daysOfHistory is low.\n' +
    '## Issues We Found\n' +
    'A short intro sentence, then a bullet list of the real issues from issuesSnapshot (group by priority, most ' +
    'important first; mention the full-site-audit status honestly if it was not yet available).\n' +
    '## What Happens Next\n' +
    '2-3 sentences explaining that this is the starting point, and that future Milestones reports will show real ' +
    'progress measured against it.';
  const user = `site: ${site.name}\ndate: ${new Date().toISOString().slice(0, 10)}\nkpiSnapshot: ${JSON.stringify(kpiSnapshot)}\nissuesSnapshot: ${JSON.stringify(issuesSnapshot)}`;
  const raw = await callLLM(system, user, { maxTokens: 900 })
    .catch((err) => { console.warn('[baseline-report] narrative failed:', err.message); return null; });
  return raw?.trim() || `# Baseline Report — ${site.name}\n\nReport generation failed — please retry.`;
}
