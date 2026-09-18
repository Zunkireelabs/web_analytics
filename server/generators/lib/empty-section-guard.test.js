import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEmptySections } from './empty-section-guard.js';

test('real sections/items produce no issues', () => {
  const content = {
    sections: [{ heading: 'A', body: 'A real paragraph with enough real words in it to count.' }],
    items: [{ question: 'What is this?', answer: 'A real grounded answer about the topic.' }],
  };
  assert.deepEqual(findEmptySections(content), []);
});

test('flags an empty body', () => {
  const content = { sections: [{ heading: 'Pricing', body: '' }] };
  const issues = findEmptySections(content);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].patternId, 'empty-section');
});

test('flags a non-answer placeholder', () => {
  const content = { items: [{ question: 'How much does it cost?', answer: 'N/A' }] };
  const issues = findEmptySections(content);
  assert.equal(issues.length, 1);
});

test('flags a too-short body', () => {
  const content = { sections: [{ heading: 'A', body: 'Not much here.' }] };
  const issues = findEmptySections(content);
  assert.equal(issues.length, 1);
});

test('a genuinely short but real FAQ answer is not flagged', () => {
  const content = { items: [{ question: 'Is shipping free?', answer: 'Yes, on all orders over $50.' }] };
  assert.deepEqual(findEmptySections(content), []);
});

test('non-array fields and non-object items are ignored', () => {
  const content = { page: '/x', focus: 'general', tags: ['a', 'b'] };
  assert.deepEqual(findEmptySections(content), []);
});

// Real incident, Chayce Properties (site 8864), 2026-09-18: organizationByline()
// deterministically returns "By the Chayceproperties Team" (4 words) for any
// site with no individual author configured — a correct, permanent, non-LLM
// value that MIN_SECTION_BODY_WORDS (5) rejected on every one of 3 retry
// attempts, because regenerating a pure function produces the identical
// string every time. Under content.focus = 'author-byline' the length check
// must be skipped so this can ever pass.
test('a short deterministic author-byline is not flagged as an empty section', () => {
  const content = { focus: 'author-byline', sections: [{ heading: 'About the Author', body: 'By the Chayceproperties Team' }] };
  assert.deepEqual(findEmptySections(content), []);
});

test('an author-byline section is still flagged if genuinely empty', () => {
  const content = { focus: 'author-byline', sections: [{ heading: 'About the Author', body: '' }] };
  const issues = findEmptySections(content);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].patternId, 'empty-section');
});

test('a too-short body under a DIFFERENT focus is still flagged (exemption is focus-scoped, not global)', () => {
  const content = { focus: 'comparison-content', sections: [{ heading: 'A', body: 'Not much here.' }] };
  const issues = findEmptySections(content);
  assert.equal(issues.length, 1);
});
