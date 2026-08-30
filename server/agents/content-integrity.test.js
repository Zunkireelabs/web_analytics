import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findInconsistentFaqQuestions } from './content-integrity.js';

function page(url, items) {
  return { page: url, analysis: { faqVisibleItems: items } };
}

describe('findInconsistentFaqQuestions', () => {
  test('flags the same real question answered differently on two different pages', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: 'When do you ship?', answer: 'Within 5 business days.' }]),
    ];
    const result = findInconsistentFaqQuestions(reachable);
    assert.equal(result.length, 1);
    assert.equal(result[0].question, 'when do you ship?');
    assert.equal(result[0].variants.length, 2);
  });

  test('does not flag the same question with the same real answer (whitespace/case-insensitive)', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: '  When Do You Ship?  ', answer: '  within 2   business days.  ' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('ignores items with no confidently-extracted answer', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: null }]),
      page('https://example.com/b', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('does not flag a question that only appears on one page', () => {
    const reachable = [
      page('https://example.com/a', [{ question: 'When do you ship?', answer: 'Within 2 business days.' }]),
      page('https://example.com/b', [{ question: 'Do you ship internationally?', answer: 'Yes, worldwide.' }]),
    ];
    assert.deepEqual(findInconsistentFaqQuestions(reachable), []);
  });

  test('empty input -> empty result', () => {
    assert.deepEqual(findInconsistentFaqQuestions([]), []);
  });
});
