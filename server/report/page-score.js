// Page score: how healthy one page is, 0-100, from the audit findings on it. A page starts at 100 and loses points
// for each open finding by priority. It is derived, not measured, and says so: the report shows the same page scored
// the same way at the first audit and at the latest one, so the change is real even though the number is a summary.
// Nothing is invented: a page the latest audit did not reach is skipped rather than assumed to be 100.
export const PENALTY = { high: 12, medium: 6, low: 2 };

export function scorePage(findings) {
  const lost = findings.reduce((sum, f) => sum + (PENALTY[f.priority] ?? 0), 0);
  return Math.max(0, 100 - lost);
}

const byPage = (findings) => {
  const m = new Map();
  for (const f of findings) {
    if (!f.page) continue; // site-level findings belong to no single page
    if (!m.has(f.page)) m.set(f.page, []);
    m.get(f.page).push(f);
  }
  return m;
};

// `reached` = pages the latest audit actually crawled; a page it never reached has no "now" score.
export function pageScoreRows(baselineFindings, latestFindings, { reached, limit = 5 } = {}) {
  const before = byPage(baselineFindings);
  const now = byPage(latestFindings);
  const rows = [];
  for (const [page, f] of before) {
    if (reached && !reached.has(page) && !now.has(page)) continue;
    const b = scorePage(f);
    const a = scorePage(now.get(page) || []);
    if (a > b) rows.push({ page, before: b, now: a, change: a - b });
  }
  return rows.sort((x, y) => y.change - x.change || x.page.localeCompare(y.page)).slice(0, limit);
}

const pathOf = (url) => { try { return new URL(url).pathname || '/'; } catch { return url; } };

// The report section, or null when there are not two different finished audits or nothing improved.
export function pageScoreSection({ baselineRun, latestRun, baselineFindings, latestFindings, reached }) {
  if (!baselineRun || !latestRun || baselineRun.id === latestRun.id) return null;
  const rows = pageScoreRows(baselineFindings, latestFindings, { reached });
  if (!rows.length) return null;
  return {
    title: 'Page scores that improved',
    sub: 'Each page starts at 100 and loses points for every open issue. Compared with your first audit.',
    table: {
      head: ['Page', 'Before', 'Now', 'Change'],
      rows: rows.map((r) => [pathOf(r.page), String(r.before), String(r.now), { t: `▲ +${r.change}`, tone: 'good' }]),
    },
  };
}
