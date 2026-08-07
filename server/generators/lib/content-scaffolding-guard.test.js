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

test('blog-outline generator is exempt from the guard', () => {
  const content = { sections: [{ heading: 'Section 1', notes: 'TODO expand with real internal links' }] };
  assert.deepEqual(findScaffoldingIssues(content, 'blog-outline'), []);
});
