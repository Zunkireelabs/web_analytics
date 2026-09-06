import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEditLesson } from './draft-lesson-extraction.js';

test('no diff -> null (nothing to learn)', () => {
  const content = { sections: [{ heading: 'A', body: 'Real body text here.' }] };
  assert.equal(extractEditLesson('expand-content', content, content), null);
});

// The two text-quoting assertions this test used to make were removed on
// purpose, not relaxed: the lesson must NOT contain either version of the
// drafted copy, because agent_fix_memory is cross-tenant. What it must still
// carry is the field path and the shape of the correction. See
// lesson-privacy.test.js for the regression wall on the leak itself.
test('a real field edit produces a lesson describing the correction', () => {
  const original = { sections: [{ heading: 'A', body: 'The drafted body text.' }] };
  const edited = { sections: [{ heading: 'A', body: 'The corrected body text, now rather longer than it was.' }] };
  const result = extractEditLesson('expand-content', original, edited);
  assert.ok(result);
  assert.match(result.title, /expand-content/);
  assert.match(result.lesson, /sections\[0\]\.body/);
  assert.match(result.lesson, /expanded it by roughly \d+%/);
  assert.doesNotMatch(result.lesson, /drafted body text/);
  assert.doesNotMatch(result.lesson, /corrected body text/);
  assert.equal(result.category, 'human-correction');
  assert.equal(result.validationRuleId, 'human-edit:expand-content:sections[].body');
});

test('a diff spanning more than one distinct field gets no validationRuleId — not a single recurring pattern', () => {
  const original = { heading: 'Old headline', sections: [{ body: 'Old body text here.' }] };
  const edited = { heading: 'New headline', sections: [{ body: 'New body text here.' }] };
  const result = extractEditLesson('landing-page', original, edited);
  assert.equal(result.validationRuleId, null);
});

test('missing original or edited content -> null', () => {
  assert.equal(extractEditLesson('schema', null, { a: 'b' }), null);
  assert.equal(extractEditLesson('schema', { a: 'b' }, null), null);
});

test('caps the number of diffs included in the lesson', () => {
  const original = { items: [
    { answer: 'answer one original text' }, { answer: 'answer two original text' },
    { answer: 'answer three original text' }, { answer: 'answer four original text' },
  ] };
  const edited = { items: [
    { answer: 'answer one EDITED text' }, { answer: 'answer two EDITED text' },
    { answer: 'answer three EDITED text' }, { answer: 'answer four EDITED text' },
  ] };
  const result = extractEditLesson('faq', original, edited);
  // Counted via the per-diff field-path segment rather than the edited text
  // itself — the lesson no longer reproduces either version of the copy, so
  // counting "EDITED" would now always be 0 and silently stop testing the cap.
  const mentions = (result.lesson.match(/On "items\[\d+\]\.answer"/g) || []).length;
  assert.equal(mentions, 3);
});
