import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQualityGate } from './quality-gate.js';

test('clean content passes the gate', async () => {
  const content = { page: '/x', items: [{ question: 'What is this?', answer: 'A real grounded answer about the topic.' }] };
  const result = await runQualityGate(content, 'qa-content');
  assert.equal(result.clean, true);
  assert.deepEqual(result.issues, []);
});

test('aggregates issues across all three checkers', async () => {
  const content = {
    sections: [
      { heading: 'A', body: 'TODO: write a real paragraph here about the first subtopic in real depth.' },
      { heading: 'B', body: 'TODO: write a real paragraph here about the first subtopic in real depth.' },
    ],
    jsonLd: { '@type': 'Article' },
  };
  const result = await runQualityGate(content, 'expand-content');
  assert.equal(result.clean, false);
  const ids = result.issues.map((i) => i.patternId);
  assert.ok(ids.includes('todo-marker'));
  assert.ok(ids.includes('duplicate-paragraph'));
  assert.ok(ids.includes('schema-missing-context'));
});

test('landing-page: an ungrounded claim fails the gate with a repairable correction', async () => {
  const content = {
    headline: 'Grow Your Business',
    sections: [{ heading: 'Why Us', body: 'We have served 500+ clients and are the industry-leading provider.' }],
    groundingContext: 'This business offers AI development services in Kathmandu.',
  };
  const result = await runQualityGate(content, 'landing-page');
  assert.equal(result.clean, false);
  const claimIssues = result.issues.filter((i) => i.patternId === 'ungrounded-claim');
  assert.equal(claimIssues.length, 2, 'both the scale claim and the superlative should be flagged');
  assert.ok(claimIssues.every((i) => typeof i.correction === 'string' && i.correction.length > 0), 'every issue must carry a correction so the repair loop can act on it');
});

test('landing-page: claims backed by the real groundingContext pass cleanly', async () => {
  const content = {
    headline: 'Grow Your Business',
    sections: [{ heading: 'Why Us', body: 'We have served 500 clients since 2018.' }],
    groundingContext: 'Real data: this business has served 500 clients since 2018.',
  };
  const result = await runQualityGate(content, 'landing-page');
  assert.equal(result.clean, true);
});

test('blog-outline: an ungrounded price claim fails the gate', async () => {
  const content = {
    title: 'How Much Does AI Development Cost',
    sections: [{ heading: 'Pricing', body: 'Expect to pay around $5,000 for a typical project.' }],
    groundingContext: 'This business builds AI systems and enterprise software.',
  };
  const result = await runQualityGate(content, 'blog-outline');
  assert.equal(result.clean, false);
  assert.ok(result.issues.some((i) => i.patternId === 'ungrounded-claim'));
});

test('direct-answer: a claim backed by the real groundingContext passes cleanly', async () => {
  const content = {
    title: 'AI Development in Nepal',
    heading: 'Who builds AI systems in Kathmandu?',
    directAnswer: 'Several companies in Kathmandu, including ones with 500 clients since 2018, build custom AI systems.',
    supportingSections: [],
    groundingContext: 'Real data: this business has served 500 clients since 2018.',
  };
  const result = await runQualityGate(content, 'direct-answer');
  assert.equal(result.clean, true);
});

test('the claim-grounding check is scoped to CLAIM_GROUNDED_GENERATOR_IDS only — an unrelated generator with the same text is unaffected', async () => {
  const content = {
    sections: [{ heading: 'Why Us', body: 'We have served 500+ clients and are the industry-leading provider of real, grounded prose that is long enough to avoid other guards.' }],
  };
  const result = await runQualityGate(content, 'qa-content');
  assert.equal(result.issues.some((i) => i.patternId === 'ungrounded-claim'), false);
});

test('blog-outline is no longer exempt from the gate', async () => {
  const content = { sections: [{ heading: 'Section 1', body: '[Insert real content here]' }] };
  const result = await runQualityGate(content, 'blog-outline');
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
test('duplicate-id-fix is exempt from LLM-misbehavior checks (nav-leakage, duplicate-paragraph) — it quotes real markup, never generates prose', async () => {
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
  const result = await runQualityGate(content, 'duplicate-id-fix');
  assert.equal(result.clean, true);
  assert.deepEqual(result.issues, []);
});

test('the same nav-leakage text still fails the gate for a real content generator (exemption is scoped to duplicate-id-fix only)', async () => {
  const content = { sections: [{ heading: 'Nav', body: 'Toggle navigation to see more options in the real menu.' }] };
  const result = await runQualityGate(content, 'expand-content');
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
test('geo-audit is exempt from LLM-misbehavior checks — repeated static finding labels across pages are expected, not an LLM restating itself', async () => {
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
  const result = await runQualityGate(content, 'geo-audit');
  assert.equal(result.clean, true);
  assert.deepEqual(result.issues, []);
});
