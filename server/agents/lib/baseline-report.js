import { getSiteById, getDailySeries, getHealthScoreOnOrBefore } from '../../store/read.js';
import { getLatestAgentRuns } from '../../store/agent-runs.js';
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

// audit_page_findings.finding_id is per-page AND per-issue, shaped either
// "accessibility:heading-skip" or "content-gap:https://site/page:Missing alt
// text" — the URL in the middle means splitting on ':' is unsafe, but the
// human-readable defect label is always the LAST segment. That label is what
// turns 1,700 rows into "Missing alt text — 43 pages", which is the whole
// difference between a number and an audit.
function defectLabel(findingId) {
  const label = String(findingId || '').split(':').pop().trim();
  return label || 'Other';
}

// The real per-page defects, grouped so a reader can see WHAT is missing and
// HOW WIDESPREAD it is. These rows were already being fetched and then
// reduced to `auditFindings.length` — a single count — which is why the
// day-0 document could only ever say "we found N issues" instead of naming
// them. Nothing new is queried here; this only stops discarding what was
// already loaded.
function summarizeAuditFindings(auditFindings) {
  if (!auditFindings.length) return null;

  const byCategory = new Map();
  const byDefect = new Map();
  for (const f of auditFindings) {
    const cat = f.agent_id || 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, { category: cat, count: 0, pages: new Set(), high: 0 });
    const c = byCategory.get(cat);
    c.count += 1;
    if (f.page) c.pages.add(f.page);
    if (f.priority === 'high') c.high += 1;

    const label = defectLabel(f.finding_id);
    const key = `${cat}|${label}`;
    if (!byDefect.has(key)) byDefect.set(key, { issue: label, category: cat, priority: f.priority, count: 0, pages: new Set() });
    const d = byDefect.get(key);
    d.count += 1;
    if (f.page) d.pages.add(f.page);
  }

  const pagesAffected = new Set(auditFindings.map((f) => f.page).filter(Boolean));
  return {
    total: auditFindings.length,
    // getAuditPageFindings is capped at AUDIT_FINDINGS_LIMIT, and real sites
    // hit it (site 8862's onboarding audit returned exactly 500). Reporting
    // that as the total would understate the site's real state in a document
    // whose entire value is being an accurate day-0 measurement, so the
    // narrative is told to say "at least N" rather than a false exact count.
    truncated: auditFindings.length >= AUDIT_FINDINGS_LIMIT,
    pagesAffected: pagesAffected.size,
    byCategory: [...byCategory.values()]
      .map((c) => ({ category: c.category, count: c.count, pages: c.pages.size, highPriority: c.high }))
      .sort((a, b) => b.count - a.count),
    // Capped: the narrative needs the shape of the problem, not every row.
    topDefects: [...byDefect.values()]
      .sort((a, b) => b.pages.size - a.pages.size || b.count - a.count)
      .slice(0, 15)
      .map((d) => ({
        issue: d.issue, category: d.category, priority: d.priority,
        pages: d.pages.size, examplePages: [...d.pages].slice(0, 3),
      })),
  };
}

// AI-search readiness, the part of a day-0 audit a traditional SEO report
// does not have at all: whether answer engines can read, understand and cite
// this site. Sourced from the geo-audit agent's own stored run (its scores
// are computed per page from real fetched HTML — see agents/lib/
// geo-audit-report.js), never recomputed or estimated here. Absent when the
// audit hasn't run for this site yet, and the narrative is told to say so
// rather than imply a score exists.
// Banding is done HERE, in code, not by the model. Asking the narrative to
// apply "0-39 Missing / 40-69 Partial / 70-100 Good" to seven numbers is
// asking an LLM to do arithmetic, and it got it wrong on the first real
// Admizz report: schema 25 and faq 30 were both labelled "Partial" in the
// table while the prose one paragraph below correctly called faq 30 a gap.
// Understating a client's real deficit — and contradicting itself doing so
// — is exactly the failure a measurement document cannot have.
const AI_STATUS_BANDS = [
  { max: 39, label: 'Missing' },
  { max: 69, label: 'Partial' },
  { max: 100, label: 'Good' },
];

function aiCategoryStatus(score) {
  return AI_STATUS_BANDS.find((b) => score <= b.max)?.label || 'Good';
}

// Readable category names, so the client-facing table doesn't print raw
// internal keys ("llmsReadiness", "geoSignals").
const AI_CATEGORY_LABELS = {
  faq: 'FAQ coverage',
  schema: 'Schema markup',
  entities: 'Entity markup',
  geoSignals: 'Local/GEO signals',
  llmsReadiness: 'AI crawler access (llms.txt)',
  citationReadiness: 'Citation readiness',
  structuredContent: 'Structured content',
};

function summarizeAiVisibility(geoRun) {
  const score = geoRun?.facts?.siteScore;
  if (!score || score.overall == null) return { available: false };
  const categories = Object.entries(score.categories || {})
    .map(([key, value]) => ({
      category: AI_CATEGORY_LABELS[key] || key,
      score: value,
      status: aiCategoryStatus(Number(value) || 0),
    }))
    .sort((a, b) => a.score - b.score); // worst first — the gaps are the point
  return {
    available: true,
    overall: score.overall,
    categories,
    measuredAt: geoRun.created_at || null,
  };
}

function summarizeIssuesSnapshot(recommendations, auditRun, auditFindings, geoRun) {
  const byPriority = { high: 0, medium: 0, low: 0 };
  for (const r of recommendations) byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
  return {
    openRecommendations: {
      total: recommendations.length,
      byPriority,
      items: recommendations.slice(0, 50).map((r) => ({
        // `page` is only a real URL for page-scoped recommendations. For a
        // net-new page it carries an internal generator PARAMETER instead
        // (a real observed value: "landing::Kathmandu"), which the narrative
        // then rendered as a markdown link — shipping an internal identifier
        // and a dead link into the first document a client ever reads.
        // Passed through only when it is genuinely a URL.
        page: /^https?:\/\//i.test(r.page || '') ? r.page : null,
        type: r.recommendation_type,
        issue: r.issue,
        priority: r.priority,
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
    auditFindings: summarizeAuditFindings(auditFindings),
    aiVisibility: summarizeAiVisibility(geoRun),
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

  const [dailySeries, healthScore, recommendations, auditRun, geoRuns] = await Promise.all([
    getDailySeries(siteId, windowStart, today),
    getHealthScoreOnOrBefore(siteId, today),
    listOpenRecommendations(siteId),
    getLatestAuditRun(siteId),
    // Best-effort, same tolerance as the in-progress audit below: a site
    // whose GEO audit hasn't run yet simply has no AI-visibility section.
    getLatestAgentRuns(siteId, ['geo-audit']).catch(() => []),
  ]);
  // Full site audit runs fire-and-forget alongside onboarding (see
  // runBaselineSequence) and can genuinely still be in progress when this
  // generates — that's fine, the same as review-report.js tolerating a
  // short health-score series: honestly reflect whatever exists right now
  // rather than blocking the baseline on a slow crawl finishing.
  const auditFindings = auditRun ? await getAuditPageFindings(auditRun.id, { limit: AUDIT_FINDINGS_LIMIT }) : [];

  const kpiSnapshot = summarizeKpiSnapshot(dailySeries, healthScore);
  const issuesSnapshot = summarizeIssuesSnapshot(recommendations, auditRun, auditFindings, geoRuns?.[0] || null);

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
    'This is a FINDINGS-ONLY document: report what is missing and why it matters. Never promise a fix, a ' +
    'timeline, or a result, and never say who will do the work.\n\n' +
    'Return ONLY a markdown document (no JSON, no code fences) with exactly these headings, in this order:\n' +
    '# Baseline Report — <site name> — <today\'s date>\n' +
    '## Where Your Website Stood\n' +
    '2-4 sentences on the real KPI starting point (clicks/impressions/sessions/health score), honest about how ' +
    'little history exists if daysOfHistory is low.\n' +
    '## How AI Search Engines See You Today\n' +
    'Use issuesSnapshot.aiVisibility. If available is false, say plainly that this measurement has not run yet ' +
    'and skip the rest of this section — never imply a score. If available: lead with the overall score out of ' +
    '100, then a markdown table with columns Area | Score | Status, one row per entry in aiVisibility.categories ' +
    'IN THE ORDER GIVEN (worst first), copying its category, score and status values EXACTLY — the status word is ' +
    'already computed for you, never re-derive or soften it. Then 2-3 sentences a non-technical owner understands: AI assistants and AI ' +
    'Overviews increasingly answer questions directly instead of sending a click, and these categories are what ' +
    'decides whether this site can be read, understood and cited by them. Call out the WORST categories by name ' +
    'and what each one concretely means is absent (e.g. entity markup at 0 means AI engines have nothing telling ' +
    'them what this organisation is).\n' +
    '## What Your Site Is Missing Today\n' +
    'Use issuesSnapshot.auditFindings. If it is null, say the crawl had not finished and skip this section. ' +
    'Otherwise open with the real scale ("X findings across Y pages" — but if truncated is true the crawl was '
    + 'capped, so write "at least X" and never present it as a complete count), then a markdown table of the top defects: ' +
    'columns Issue | Pages affected | Priority, using topDefects verbatim — these are real defect labels, do not ' +
    'reword them into something the data does not say. Then one short paragraph naming the 2-3 defects that ' +
    'affect the most pages and why each matters for being found.\n' +
    '## Issues We Found\n' +
    'A short intro sentence, then a bullet list of the real issues from openRecommendations (group by priority, ' +
    'most important first; mention the full-site-audit status honestly if it was not yet available). Write each ' +
    'one in plain client-facing language: describe the issue, and never paste an internal identifier, generator ' +
    'name, or parameter. Only link a page when its `page` field is a real URL — when page is null, describe the ' +
    'issue in words with no link at all.\n' +
    '## Your Starting Point\n' +
    '2-3 sentences: this is the measured state of the site today, and every future report is compared against ' +
    'these exact numbers. State it as a baseline for measurement — do not promise improvements.';
  const user = `site: ${site.name}\ndate: ${new Date().toISOString().slice(0, 10)}\nkpiSnapshot: ${JSON.stringify(kpiSnapshot)}\nissuesSnapshot: ${JSON.stringify(issuesSnapshot)}`;
  const raw = await callLLM(system, user, { maxTokens: 1800 })
    .catch((err) => { console.warn('[baseline-report] narrative failed:', err.message); return null; });
  return raw?.trim() || `# Baseline Report — ${site.name}\n\nReport generation failed — please retry.`;
}
