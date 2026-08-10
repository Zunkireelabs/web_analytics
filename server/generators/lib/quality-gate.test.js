import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQualityGate } from './quality-gate.js';

test('clean content passes the gate', () => {
  const content = { page: '/x', items: [{ question: 'What is this?', answer: 'A real grounded answer about the topic.' }] };
  const result = runQualityGate(content, 'qa-content');
  assert.equal(result.clean, true);
  assert.deepEqual(result.issues, []);
});

test('aggregates issues across all three checkers', () => {
  const content = {
    sections: [
      { heading: 'A', body: 'TODO: write a real paragraph here about the first subtopic in real depth.' },
      { heading: 'B', body: 'TODO: write a real paragraph here about the first subtopic in real depth.' },
    ],
    jsonLd: { '@type': 'Article' },
  };
  const result = runQualityGate(content, 'expand-content');
  assert.equal(result.clean, false);
  const ids = result.issues.map((i) => i.patternId);
  assert.ok(ids.includes('todo-marker'));
  assert.ok(ids.includes('duplicate-paragraph'));
  assert.ok(ids.includes('schema-missing-context'));
});

test('blog-outline is no longer exempt from the gate', () => {
  const content = { sections: [{ heading: 'Section 1', body: '[Insert real content here]' }] };
  const result = runQualityGate(content, 'blog-outline');
  assert.equal(result.clean, false);
});

// Real incident, 2026-08-10: duplicate-id-fix.js makes zero LLM calls — its
// `snippet` fields are real, verbatim page markup quoted for a developer to
// review, not generated prose. A duplicate id disproportionately lands on a
// repeated nav/menu component, so its quoted snippet routinely contains real
// text the scaffolding guard's nav-leakage pattern was built to catch an LLM
// echoing (e.g. "Toggle navigation") — and since generate() is deterministic,
// that made "Fix duplicate element IDs" fail the gate on every attempt, for
// every occurrence of this kind, permanently (not a flaky retry case).
test('duplicate-id-fix is exempt from LLM-misbehavior checks (nav-leakage, duplicate-paragraph) — it quotes real markup, never generates prose', () => {
  const content = {
    fixPlan: [{
      id: 'menu-toggle',
      count: 2,
      occurrences: [
        { tag: 'button', snippet: '<button id="menu-toggle" aria-label="Toggle navigation">☰</button>', keep: true, suggestedId: 'menu-toggle' },
        { tag: 'button', snippet: '<button id="menu-toggle" aria-label="Toggle navigation">☰</button>', keep: false, suggestedId: 'menu-toggle-2' },
      ],
    }],
  };
  const result = runQualityGate(content, 'duplicate-id-fix');
  assert.equal(result.clean, true);
  assert.deepEqual(result.issues, []);
});

test('the same nav-leakage text still fails the gate for a real content generator (exemption is scoped to duplicate-id-fix only)', () => {
  const content = { sections: [{ heading: 'Nav', body: 'Toggle navigation to see more options in the real menu.' }] };
  const result = runQualityGate(content, 'expand-content');
  assert.equal(result.clean, false);
  assert.ok(result.issues.some((i) => i.patternId === 'nav-leakage'));
});

// Real incident, 2026-08-10: geo-audit.js aggregates findings across every
// page on a site, and each finding's recommendedAction.label is one of a
// handful of fixed strings from geo-signals.js's GEO_SIGNAL_RULES — legitimately
// identical across every page sharing that issue, not an LLM restating
// itself. A real full-site audit against Zunkiree Labs failed this gate on
// every attempt once enough pages shared a finding type (dozens of
// duplicate-paragraph hits on the exact same static label text).
test('geo-audit is exempt from LLM-misbehavior checks — repeated static finding labels across pages are expected, not an LLM restating itself', () => {
  const staticLabel = 'Add author/byline markup (schema author field or visible byline) so AI engines attribute the content.';
  const content = {
    report: '## Findings',
    score: { overall: 70, categories: {} },
    pagesAnalyzed: 3,
    findings: [
      { page: '/a/', whyItMatters: 'AI Visibility score 51/100 for this page (26 impressions).', recommendedAction: { label: staticLabel } },
      { page: '/b/', whyItMatters: 'AI Visibility score 51/100 for this page (26 impressions).', recommendedAction: { label: staticLabel } },
      { page: '/c/', whyItMatters: 'AI Visibility score 51/100 for this page (26 impressions).', recommendedAction: { label: staticLabel } },
    ],
  };
  const result = runQualityGate(content, 'geo-audit');
  assert.equal(result.clean, true);
  assert.deepEqual(result.issues, []);
});
