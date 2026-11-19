// What a saved baseline report is missing, read from the report the server already returns (issuesSnapshot, built by
// server/agents/lib/baseline-report.js). A baseline is frozen on the day it is built, so one built before the audit crawl
// finished or before the AI visibility check ran says so in its text but offers no way to fill the gap. Pure, so it is tested.
//
//   fullSiteAudit.status !== 'completed'  the audit crawl had not finished (a failed or reaped run still has available: true,
//                                         so `available` is not the signal, the status is)
//   aiVisibility.available !== true       the AI visibility check had not run
//
// A report with no issuesSnapshot at all (an older row) reports nothing: there is no evidence either way.
export function baselineGaps(report) {
  const snap = report?.available ? report.issuesSnapshot : null;
  if (!snap || typeof snap !== 'object') return [];
  const gaps = [];
  if (snap.fullSiteAudit?.status !== 'completed') gaps.push({ id: 'audit', label: 'the site audit crawl had not finished' });
  if (snap.aiVisibility?.available !== true) gaps.push({ id: 'ai-visibility', label: 'the AI visibility check had not run' });
  return gaps;
}
