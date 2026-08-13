import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractEditLesson } from './draft-lesson-extraction.js';
import { sanitizeLessonText } from '../../agent-memory.js';

// agent_fix_memory is a CROSS-TENANT store: a row written with site_id NULL is
// retrievable by every other client's generators via withAgentMemory
// (server/llm.js:73). So anything client-identifying that reaches a lesson
// field can surface inside a different client's generation prompt.
//
// Until this landed, draft-lesson-extraction.js quoted a human's verbatim
// draft corrections (160 chars of each side) straight into `symptoms`. These
// tests are the regression wall for that whole class of leak.

describe('extractEditLesson — never reproduces client draft text', () => {
  const original = {
    metaDescription: 'Emergency blood donation in Kathmandu — call LifeLinkNepal on 01-5551234 today.',
  };
  const edited = {
    metaDescription: 'Find verified blood donors near you, fast.',
  };

  test('neither the drafted nor the corrected text appears in the lesson', () => {
    const { lesson } = extractEditLesson('meta-title', original, edited);
    assert.doesNotMatch(lesson, /LifeLinkNepal/);
    assert.doesNotMatch(lesson, /Kathmandu/);
    assert.doesNotMatch(lesson, /01-5551234/);
    assert.doesNotMatch(lesson, /verified blood donors/);
  });

  test('it still records WHICH field was corrected — the part that makes it reusable', () => {
    const { lesson, validationRuleId } = extractEditLesson('meta-title', original, edited);
    assert.match(lesson, /metaDescription/);
    assert.equal(validationRuleId, 'human-edit:meta-title:metaDescription');
  });

  test('it describes the shape of the correction', () => {
    const { lesson } = extractEditLesson('meta-title', original, edited);
    assert.match(lesson, /shortened it by roughly \d+%/);
  });

  test('a link being removed is recorded as a fact, without the link', () => {
    const { lesson } = extractEditLesson('faq',
      { answer: 'See our full policy at https://lifelinknepal.com/private/policy for details.' },
      { answer: 'See our full policy page for the details you need here.' });
    assert.match(lesson, /removed a link/);
    assert.doesNotMatch(lesson, /lifelinknepal/i);
    assert.doesNotMatch(lesson, /https?:\/\//);
  });

  test('numbers being introduced is recorded without the numbers', () => {
    const { lesson } = extractEditLesson('expand-content',
      { body: 'We have helped many donors across the region every single month.' },
      { body: 'We have helped 4821 donors across the region since March 2024 alone.' });
    assert.match(lesson, /introduced specific numbers/);
    assert.doesNotMatch(lesson, /4821/);
  });

  test('a same-length reword is described as such, not as a resize', () => {
    const { lesson } = extractEditLesson('meta-title',
      { title: 'Blood donation services available near you today' },
      { title: 'Blood donor matching available near you at once' });
    assert.match(lesson, /reworded it at about the same length/);
  });

  test('returns null when nothing changed, as before', () => {
    assert.equal(extractEditLesson('meta-title', original, original), null);
  });
});

describe('sanitizeLessonText — the write-path wall', () => {
  test('strips URLs', () => {
    assert.equal(
      sanitizeLessonText('The page https://admizz.com/courses/mba had a broken tag.'),
      'The page <url> had a broken tag.',
    );
  });

  test('strips email addresses', () => {
    assert.match(sanitizeLessonText('Contact info.zunkireelabs@gmail.com was in the draft.'), /<email>/);
    assert.doesNotMatch(sanitizeLessonText('Contact info.zunkireelabs@gmail.com was in the draft.'), /gmail/);
  });

  test('collapses a long quoted run of reproduced copy', () => {
    const copy = 'A'.repeat(120);
    const out = sanitizeLessonText(`A human corrected it to "${copy}" before approving.`);
    assert.match(out, /"<quoted-content>"/);
    assert.doesNotMatch(out, /AAAA/);
  });

  test('leaves a short legitimate quote alone — this redacts, it does not mangle', () => {
    const text = 'The Quality Gate pattern "todo-marker" fired on the first attempt.';
    assert.equal(sanitizeLessonText(text), text);
  });

  test('reuses lib/errors.js leak patterns for provider/internal detail', () => {
    // Whole-string redaction, matching sanitizeForCustomer's documented
    // "a partially-redacted error is still an error message" rule.
    const out = sanitizeLessonText('Fix failed with HTTP 503 from the upstream provider.');
    assert.match(out, /^\(redacted/);
  });

  test('never returns empty for a NOT NULL column', () => {
    assert.ok(sanitizeLessonText('https://example.com').length > 0);
  });

  test('passes through null/undefined untouched', () => {
    assert.equal(sanitizeLessonText(null), null);
    assert.equal(sanitizeLessonText(undefined), undefined);
  });
});
