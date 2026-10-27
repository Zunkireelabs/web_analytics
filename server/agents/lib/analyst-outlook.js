// Shapes the Analyst page's two subpages (Outlook, Fixes) from what already exists: the Python
// service's persisted predictions, and the Node side's recommendations, drafts and measured fixes.
// Pure where it can be, so the stage logic is unit-testable without a database.

// Same normalisation on both sides of every page match (Python stores absolute URLs, drafts and
// recommendations may hold paths).
export function pathKey(page) {
  if (!page) return '';
  let p = String(page).trim();
  try { p = new URL(p).pathname; } catch { /* already a path */ }
  p = p.toLowerCase().replace(/\/+$/, '');
  return p || '/';
}

const FIX_LABEL = {
  faq: 'Add an FAQ', 'meta-title': 'Rewrite the title', 'meta-description': 'Rewrite the description', schema: 'Add structured data',
  'expand-content': 'Refresh the content', 'direct-answer': 'Add a direct answer', canonical: 'Fix the canonical tag',
  'internal-links': 'Add internal links', 'blog-outline': 'Write a new post', 'landing-page': 'Build a landing page',
  'alt-text': 'Add image descriptions', sitemap: 'Repair the sitemap', 'llms-txt': 'Publish llms.txt',
};
export const fixLabel = (generatorId) => FIX_LABEL[generatorId] || 'Improve the page';

const DAY = 86400000;

// Which stage a predicted problem is in, from the newest draft aimed at its page since it was predicted.
//   no draft, no open recommendation -> predicted      (step 0)
//   open recommendation only          -> agent fixing   (step 1)
//   draft waiting for a person        -> needs-ok       (step 0)
//   draft approved, not live yet      -> agent fixing   (step 1)
//   draft implemented                 -> fixed          (step 2), result checked once measured (step 3)
export function stageForIssue(issue, { drafts = [], openRecommendationPages = new Set(), measuredDraftIds = new Set() } = {}) {
  const key = pathKey(issue.page);
  const since = issue.createdAt ? new Date(issue.createdAt).getTime() - 2 * DAY : 0;
  const mine = drafts
    .filter((d) => pathKey(d.page) === key && new Date(d.createdAt).getTime() >= since && d.status !== 'abandoned')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const d = mine[0];
  if (d) {
    if (d.status === 'implemented') return { stage: 'fixed', step: measuredDraftIds.has(d.id) ? 3 : 2, draft: d };
    if (d.status === 'approved') return { stage: 'fixing', step: 1, draft: d };
    return { stage: 'needs-ok', step: 0, draft: d }; // draft | edited | submitted_for_approval
  }
  if (openRecommendationPages.has(key)) return { stage: 'fixing', step: 1, draft: null };
  return { stage: 'predicted', step: 0, draft: null };
}

export function buildProblems(issues, ctx) {
  return issues.map((i) => {
    const s = stageForIssue(i, ctx);
    return {
      id: i.id,
      title: `${pathKey(i.page) === '/' ? 'The homepage' : pathKey(i.page)} is likely to lose clicks`,
      where: pathKey(i.page),
      likelihoodPct: Math.round(i.likelihood * 100),
      reason: i.reason,
      fix: s.draft ? fixLabel(s.draft.actionType) : 'Prepare a fix before it happens',
      stage: s.stage,
      step: s.step,
      draftId: s.draft?.id ?? null,
    };
  });
}

const ORDER = { 'needs-ok': 0, predicted: 1, fixing: 2, fixed: 3 };
export function sortProblems(problems) {
  return [...problems].sort((a, b) => ORDER[a.stage] - ORDER[b.stage] || b.likelihoodPct - a.likelihoodPct);
}

export function countProblems(problems) {
  const n = (s) => problems.filter((p) => p.stage === s).length;
  return { predicted: n('predicted'), fixing: n('fixing'), fixed: n('fixed'), needsOk: n('needs-ok') };
}

const deltaClicks = (row) => {
  const v = Number(row?.delta?.clicks);
  return Number.isFinite(v) ? v : null;
};

export function buildSolved(measured) {
  return measured.map((m) => {
    const c = deltaClicks(m);
    return {
      id: m.id,
      title: `${fixLabel(m.generator_id)}${m.page_url ? ` · ${pathKey(m.page_url)}` : ''}`,
      when: m.measured_at,
      detail: 'Checked against real Search Console numbers after the fix went live',
      gain: c == null ? null : `${c > 0 ? '+' : ''}${c} clicks`,
    };
  });
}

export function solvedSummary(measured, now = Date.now()) {
  const recent = measured.filter((m) => m.measured_at && now - new Date(m.measured_at).getTime() <= 30 * DAY);
  const won = recent.reduce((s, m) => s + Math.max(deltaClicks(m) ?? 0, 0), 0);
  return { solvedThisMonth: recent.length, clicksWonBack: Math.round(won) };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function buildWeek(drafts, now = new Date()) {
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const out = [];
  for (const d of drafts) {
    const page = d.page ? ` on ${pathKey(d.page)}` : '';
    if (d.status === 'implemented' && d.implementedAt && new Date(d.implementedAt) >= monday) {
      out.push({ when: WEEKDAY[new Date(d.implementedAt).getDay()], title: `${fixLabel(d.actionType)}${page}`, stage: 'fixed', at: d.implementedAt });
    } else if (d.status === 'approved') {
      out.push({ when: 'Next run', title: `${fixLabel(d.actionType)}${page}`, stage: 'fixing', at: d.createdAt });
    } else if (['draft', 'edited', 'submitted_for_approval'].includes(d.status) && new Date(d.createdAt) >= monday) {
      out.push({ when: 'Waiting', title: `${fixLabel(d.actionType)}${page}`, stage: 'needs-ok', at: d.createdAt });
    }
  }
  return out.sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, 12).map(({ at, ...rest }) => rest);
}

// Plain-language shifts: outside trends (Trend radar) and what people search for on this site.
export function buildShifts({ radarTopics = [], risingQueries = [], industry = null }) {
  const shifts = [];
  // The field's own direction, learned across projects (numbers only; see data-analyst-agent/app/predict/industry.py).
  if (industry && industry.fieldChangeNext3Pct != null) {
    const f = industry.fieldChangeNext3Pct;
    const who = industry.scope === 'industry' ? 'your field' : 'projects like yours';
    const source = `Learned across ${industry.projects} projects`;
    if (Math.abs(f) < 2) shifts.push({ text: `Search demand in ${who} is expected to stay about level over the next 3 weeks`, source, direction: 'flat' });
    else shifts.push({ text: `Search demand in ${who} is expected to ${f > 0 ? 'rise' : 'fall'} about ${Math.abs(Math.round(f))}% over the next 3 weeks`, source, direction: f > 0 ? 'up' : 'down' });
    if (industry.yourRecentChangePct != null && industry.fieldRecentChangePct != null) {
      const y = Math.round(industry.yourRecentChangePct), fl = Math.round(industry.fieldRecentChangePct);
      shifts.push({
        text: `Over the last 4 weeks your searches ${y >= 0 ? 'grew' : 'fell'} ${Math.abs(y)}% while ${who} ${fl >= 0 ? 'grew' : 'fell'} ${Math.abs(fl)}%`,
        source, direction: y > fl ? 'up' : y < fl ? 'down' : 'flat',
      });
    }
  }
  for (const t of radarTopics.slice(0, 3)) shifts.push({ text: t.topic, source: 'Trend radar', direction: 'up' });
  for (const q of risingQueries.slice(0, 3)) {
    shifts.push({ text: `People are searching for "${q.query}" ${q.pctChange}% more on your site`, source: 'Your own searches', direction: 'up' });
  }
  return shifts;
}

export function buildOutlook({ py, problems, shifts }) {
  if (!py || py.status !== 'ok') {
    return { status: 'not-ready', message: py?.message || 'The Analyst has not prepared a prediction for this project yet.', forecast: null, lastWeek: null, keywords: [], shifts, problemCounts: { expected: 0, handled: 0, needsOk: 0 } };
  }
  const c = countProblems(problems);
  return {
    status: 'ok',
    forecast: py.forecast,
    lastWeek: py.lastWeek,
    keywords: py.keywords || [],
    shifts,
    problemCounts: { expected: problems.length, handled: c.fixing + c.fixed, needsOk: c.needsOk },
  };
}

export function buildFixes({ problems, measured, drafts, now = new Date() }) {
  const sorted = sortProblems(problems);
  const counts = countProblems(sorted);
  const summary = solvedSummary(measured, now.getTime());
  return {
    counts: { ...counts, ...summary },
    problems: sorted.map(({ draftId, ...p }) => p),
    solved: buildSolved(measured.slice(0, 8)),
    week: buildWeek(drafts, now),
  };
}
