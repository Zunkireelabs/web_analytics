import test from 'node:test';
import assert from 'node:assert/strict';
import { fixFor, brandOf } from './fixes.js';
import { buildTeaser, buildFullReport } from './teaser.js';

const report = {
  finalUrl: 'https://www.acme.io/', fetchedAt: 'x',
  overall: { seo: { score: 80, grade: 'B' } },
  pageMetadata: { title: 'Best CRM for startups | Acme', description: 'Acme is a simple CRM.', h1s: ['A simpler CRM'], headings: [{ tag: 'h2', text: 'How pricing works' }, { tag: 'h2', text: 'Why teams switch?' }] },
  checks: [
    { id: 'title-tag', title: 'Title', category: 'seo', maxScore: 10, score: 10, message: 'ok' },
    { id: 'qa-content', title: 'Q&A', category: 'geo', maxScore: 10, score: 0, message: 'none' },
    { id: 'freshness-signals', title: 'Fresh', category: 'geo', maxScore: 10, score: 0, message: 'none' },
    { id: 'author-expertise', title: 'Author', category: 'geo', maxScore: 10, score: 0, message: 'none' },
    { id: 'favicon', title: 'Favicon', category: 'seo', maxScore: 2, score: 0, message: 'none' },
  ],
};

test('brand comes from the last short title segment, else the hostname', () => {
  assert.equal(brandOf(report), 'Acme');
  assert.equal(brandOf({ finalUrl: 'https://x.com/', pageMetadata: { title: 'A very long title with many many words here' } }), 'x.com');
});

test('generated JSON-LD is valid JSON and never invents ratings', () => {
  const fix = fixFor({ id: 'review-rating-schema' }, report);
  const body = fix.code.replace(/<\/?script[^>]*>/g, '');
  const parsed = JSON.parse(body);
  assert.match(parsed.aggregateRating.ratingValue, /REPLACE/);
});

test('teaser shows 3 issues in full, withholds the rest, and includes one sample fix', () => {
  const t = buildTeaser(report, 'abc');
  assert.equal(t.counts.failing, 4);
  assert.equal(t.issues.filter((i) => !i.locked).length, 3);
  const locked = t.issues.find((i) => i.locked);
  assert.equal(locked.message, undefined);
  assert.ok(t.sampleFix.code);
  assert.deepEqual(t.passed.map((p) => p.id), ['title-tag']);
  assert.equal(JSON.stringify(t).includes('recommendation'), false);
});

test('full report carries every issue and its fix', () => {
  const f = buildFullReport(report);
  assert.equal(f.issues.length, 4);
  assert.ok(f.issues.find((i) => i.id === 'qa-content').fix.code.includes('FAQPage'));
});
