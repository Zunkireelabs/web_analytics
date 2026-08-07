import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEditLesson } from './draft-lesson-extraction.js';

test('no diff -> null (nothing to learn)', () => {
  const content = { sections: [{ heading: 'A', body: 'Real body text here.' }] };
  assert.equal(extractEditLesson('expand-content', content, content), null);
});

test('a real field edit produces a lesson describing the correction', () => {
  const original = { sections: [{ heading: 'A', body: 'The drafted body text.' }] };
  const edited = { sections: [{ heading: 'A', body: 'The corrected body text.' }] };
  const result = extractEditLesson('expand-content', original, edited);
  assert.ok(result);
  assert.match(result.title, /expand-content/);
  assert.match(result.lesson, /drafted body text/);
  assert.match(result.lesson, /corrected body text/);
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
  const mentions = (result.lesson.match(/EDITED/g) || []).length;
  assert.equal(mentions, 3);
});
