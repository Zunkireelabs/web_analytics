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
