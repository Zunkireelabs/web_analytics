import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateParagraphs } from './duplicate-content-guard.js';

test('clean content with distinct paragraphs produces no issues', () => {
  const content = { sections: [
    { heading: 'A', body: 'This is a real distinct paragraph about the first subtopic in enough depth.' },
    { heading: 'B', body: 'This is a completely different paragraph covering a second, unrelated subtopic.' },
  ] };
  assert.deepEqual(findDuplicateParagraphs(content), []);
});

test('flags an exact-duplicate paragraph repeated across two fields', () => {
  const body = 'This exact same sentence appears twice in the generated draft content here.';
  const content = { sections: [{ heading: 'A', body }, { heading: 'B', body }] };
  const issues = findDuplicateParagraphs(content);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].patternId, 'duplicate-paragraph');
  assert.equal(issues[0].duplicateOf, 'sections[0].body');
});

test('flags a near-duplicate that differs only in punctuation/case', () => {
  const content = {
    a: 'Our product helps teams ship faster with fewer bugs in production.',
    b: 'OUR PRODUCT HELPS TEAMS SHIP FASTER WITH FEWER BUGS IN PRODUCTION!!',
  };
  const issues = findDuplicateParagraphs(content);
  assert.equal(issues.length, 1);
});

test('does not flag short strings under the word-count floor', () => {
  const content = { q1: 'Yes.', q2: 'Yes.', heading1: 'Overview', heading2: 'Overview' };
  assert.deepEqual(findDuplicateParagraphs(content), []);
});

test('does not flag near-identical entries within a titles[] candidate list', () => {
  const content = {
    titles: [
      'Best Appliance Repair Services in Austin, TX | ABC Co',
      'Best Appliance Repair Services in Austin TX - ABC Co',
      'Top Appliance Repair in Austin, Texas | ABC Company',
    ],
    metaDescription: 'A completely separate meta description paragraph with its own distinct wording here.',
  };
  assert.deepEqual(findDuplicateParagraphs(content), []);
});

test('does not flag twitterTitle/twitterDescription mirroring ogTitle/ogDescription', () => {
  const content = {
    ogTitle: 'A Real Page Title Grounded In Fetched Content',
    ogDescription: 'A real meta description excerpt long enough to trip the paragraph floor easily.',
    twitterTitle: 'A Real Page Title Grounded In Fetched Content',
    twitterDescription: 'A real meta description excerpt long enough to trip the paragraph floor easily.',
  };
  assert.deepEqual(findDuplicateParagraphs(content), []);
});
