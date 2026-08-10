import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findScaffoldingIssues } from './content-scaffolding-guard.js';

test('clean content produces no issues', () => {
  const content = { page: '/blog/example', items: [{ question: 'What is this?', answer: 'A real grounded answer about the page topic.' }] };
  assert.deepEqual(findScaffoldingIssues(content, 'qa-content'), []);
});

test('flags TODO/TBD/FIXME markers', () => {
  const content = { sections: [{ heading: 'Intro', body: 'TODO: write this section' }] };
  const issues = findScaffoldingIssues(content, 'expand-content');
  assert.ok(issues.some((i) => i.patternId === 'todo-marker'));
});

test('flags placeholder brackets', () => {
  const content = { sections: [{ heading: 'Intro', body: '[Insert introduction paragraph here]' }] };
  const issues = findScaffoldingIssues(content, 'expand-content');
  assert.ok(issues.some((i) => i.patternId === 'placeholder-bracket'));
});

test('flags leftover template braces', () => {
  const content = { headline: 'Welcome to {{city}}' };
  const issues = findScaffoldingIssues(content, 'landing-page');
  assert.ok(issues.some((i) => i.patternId === 'template-braces'));
});

test('flags outline-style section headings used as body copy', () => {
  const content = { sections: [{ heading: 'Section 1: Overview', body: 'Section 1: cover the main points here' }] };
  const issues = findScaffoldingIssues(content, 'expand-content');
  assert.ok(issues.some((i) => i.patternId === 'outline-heading'));
});

test('flags LLM refusal/meta-commentary leakage', () => {
  const content = { answer: 'As an AI language model, I am unable to help with that request.' };
  const issues = findScaffoldingIssues(content, 'qa-content');
  assert.ok(issues.some((i) => i.patternId === 'llm-meta-commentary'));
  assert.ok(issues.some((i) => i.patternId === 'llm-refusal'));
});

test('does not flag the intentional PLACEHOLDER_NOTE convention', () => {
  const content = { jsonLd: { price: '[NEEDS INPUT — not found on the page]' } };
  assert.deepEqual(findScaffoldingIssues(content, 'schema'), []);
});

test('blog-outline generator is no longer exempt — it ships full articles now', () => {
  const content = { sections: [{ heading: 'Section 1', body: 'TODO expand with real internal links' }] };
  const issues = findScaffoldingIssues(content, 'blog-outline');
  assert.ok(issues.some((i) => i.patternId === 'todo-marker'));
});

// Defense-in-depth for the page-content.js extraction bug class (fixed
// 2026-08-07): even with real content-extraction now stripping nav/footer
// before it ever reaches an LLM prompt, this catches an LLM echoing that
// kind of boilerplate back verbatim as if it were real generated copy.
test('flags nav/template boilerplate leaking into generated copy', () => {
  const content = { sections: [{ heading: 'Intro', body: 'Skip to main content. Toggle navigation. All rights reserved.' }] };
  const issues = findScaffoldingIssues(content, 'expand-content');
  assert.ok(issues.some((i) => i.patternId === 'nav-leakage'));
});

// Sites with no configured author profile (author-profile.js) still get
// expand-content.js's old LLM-drafted "By [Author Name], [Role]" byline —
// safe for a human to see as a to-do, never safe to auto-publish since
// expand-content is 'safe'-tier and auto-remediation.js would ship it.
test('flags the "[Author Name]"/"[Role]" byline placeholder', () => {
  const content = { sections: [{ heading: 'About the Author', body: 'By [Author Name], [Role]' }] };
  const issues = findScaffoldingIssues(content, 'expand-content');
  assert.ok(issues.some((i) => i.patternId === 'author-placeholder'));
});
