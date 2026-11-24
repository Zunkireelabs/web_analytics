import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blogDayMode, applyBlogDay, blogDayEvery } from './blog-day.js';

const DAY = 86_400_000;
const ON = { BLOG_DAY_EVERY_N_DAYS: '3' };
const rec = (id, type, priority = 'medium') => ({ id, recommendation_type: type, priority });
const pool = [rec(1, 'blog-outline'), rec(2, 'faq'), rec(3, 'meta-title', 'high'), rec(4, 'expand-content', 'low'), rec(5, 'blog-outline', 'high')];

test('every third day is a blog day, and it is the same day for every project', () => {
  const modes = [0, 1, 2, 3, 4, 5, 6].map((d) => blogDayMode({ now: (18000 + d) * DAY, env: ON }));
  const idx = modes.map((m, i) => (m === 'blog' ? i : -1)).filter((i) => i >= 0);
  assert.ok(idx.every((v, i) => i === 0 || v - idx[i - 1] === 3), `blog days must be 3 apart: ${idx}`);
  assert.deepEqual(new Set(modes), new Set(['blog', 'normal']));
});
test('a blog day keeps the blogs and the high-priority fixes, and nothing else', () => {
  assert.deepEqual(applyBlogDay(pool, 'blog').map((r) => r.id), [1, 3, 5]);
});
test('every other day has no blog and keeps all the normal fixes', () => {
  assert.deepEqual(applyBlogDay(pool, 'normal').map((r) => r.id), [2, 3, 4]);
});
test('off unless set: nothing is filtered and a blog is queued daily as before', () => {
  assert.equal(blogDayMode({ env: {} }), 'off');
});
test('turned off (0 or 1), nothing is filtered: a blog is queued daily as before', () => {
  assert.equal(blogDayMode({ env: { BLOG_DAY_EVERY_N_DAYS: '0' } }), 'off');
  assert.equal(blogDayMode({ env: { BLOG_DAY_EVERY_N_DAYS: '1' } }), 'off');
  assert.equal(applyBlogDay(pool, 'off'), pool);
  assert.equal(blogDayEvery({ BLOG_DAY_EVERY_N_DAYS: 'x' }), 0);
});
test('a blog day with no blog candidate still runs the high-priority fixes', () => {
  assert.deepEqual(applyBlogDay([rec(2, 'faq'), rec(3, 'meta-title', 'high')], 'blog').map((r) => r.id), [3]);
});
test('the input list is never mutated', () => {
  const copy = [...pool]; applyBlogDay(pool, 'blog'); assert.deepEqual(pool, copy);
});

test('BLOG_DAY_START makes that date the first blog day, then every Nth day; 2026-11-25 starts the owner\'s rule', async () => {
  const { blogDayMax } = await import('./blog-day.js');
  const env = { BLOG_DAY_EVERY_N_DAYS: '3', BLOG_DAY_START: '2026-11-25' };
  const at = (iso) => blogDayMode({ now: Date.parse(`${iso}T06:00:00Z`), env });
  assert.deepEqual(['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-12-01'].map(at), ['blog', 'normal', 'normal', 'blog', 'blog']);
  assert.equal(at('2026-11-22'), 'blog', 'counting back from the start keeps the same rhythm');
  assert.equal(blogDayMax({}), 6);
  assert.equal(blogDayMax({ BLOG_DAY_MAX_BLOGS: '5' }), 5);
  assert.equal(blogDayMax({ BLOG_DAY_MAX_BLOGS: '99' }), 12);
  assert.equal(blogDayMax({ BLOG_DAY_MAX_BLOGS: 'x' }), 6);
});
