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
