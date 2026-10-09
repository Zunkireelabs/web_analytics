import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRedirectTarget, slugTokens } from './redirect-target.js';

const live = [
  'https://site.com/study-in-uk-from-nepal',
  'https://site.com/study-in-usa-from-nepal',
  'https://site.com/uk-student-visa-cost-2027',
  'https://other.com/study-in-uk-from-nepal',
];

test('slugTokens drops years, stopwords and legacy prefixes', () => {
  assert.deepEqual(slugTokens('/blogs/best-guide-to-study-in-uk-2026'), ['study', 'uk']);
});

test('legacy /blogs/ prefix maps to the same page', () => {
  const r = pickRedirectTarget('https://site.com/blogs/uk-student-visa-cost-2027', live);
  assert.equal(r.url, 'https://site.com/uk-student-visa-cost-2027');
  assert.equal(r.basis, 'legacy-prefix');
});

test('close slug picks one page; never a different host', () => {
  const r = pickRedirectTarget('https://site.com/study-in-the-uk-from-nepal-2025', live);
  assert.equal(r.url, 'https://site.com/study-in-uk-from-nepal');
});

test('ambiguous or weak matches return null', () => {
  assert.equal(pickRedirectTarget('https://site.com/study-in-from-nepal', live), null); // UK vs USA tie
  assert.equal(pickRedirectTarget('https://site.com/shifting-winds-of-education', live), null);
  assert.equal(pickRedirectTarget('https://site.com/', live), null);
});
