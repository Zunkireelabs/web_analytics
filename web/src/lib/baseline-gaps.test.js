import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineGaps } from './baseline-gaps.js';

// Shapes copied from server/agents/lib/baseline-report.js: summarizeIssuesSnapshot() / summarizeAiVisibility().
const done = { fullSiteAudit: { available: true, status: 'completed', healthScore: 61, pagesAudited: 40, findingsCount: 9 }, aiVisibility: { available: true, overall: 55, categories: [] } };

test('a complete baseline has no gaps', () => {
  assert.deepEqual(baselineGaps({ available: true, issuesSnapshot: done }), []);
});

test('Zennly\'s shape: audit unfinished and AI visibility not run -> both gaps', () => {
  const snap = { fullSiteAudit: { available: false }, aiVisibility: { available: false }, auditFindings: null };
  assert.deepEqual(baselineGaps({ available: true, issuesSnapshot: snap }).map((g) => g.id), ['audit', 'ai-visibility']);
});

test('a failed audit run still has available: true, so the status decides', () => {
  const snap = { ...done, fullSiteAudit: { available: true, status: 'failed' } };
  assert.deepEqual(baselineGaps({ available: true, issuesSnapshot: snap }).map((g) => g.id), ['audit']);
});

test('no report, loading, or an older row with no snapshot reports nothing', () => {
  assert.deepEqual(baselineGaps(null), []);
  assert.deepEqual(baselineGaps({ available: false, message: 'x' }), []);
  assert.deepEqual(baselineGaps({ available: true }), []);
});
