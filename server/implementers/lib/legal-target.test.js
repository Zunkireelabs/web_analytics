import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLegalTarget, isPlaceholderDir } from './legal-target.js';

const SITE = (pages) => ({ id: 1, url_file_map: { pages } });
const reader = (files) => async (_s, path) => (files[path] === undefined ? null : { content: files[path], sha: 's' });

describe('isPlaceholderDir', () => {
  test('docs and content-drafts are placeholders; a real source folder is not', () => {
    for (const d of ['docs', 'docs/', './docs', 'content-drafts', 'src/content-drafts']) assert.equal(isPlaceholderDir(d), true, d);
    for (const d of ['src/blog', 'src/pages', 'src/app', '', null, undefined]) assert.equal(isPlaceholderDir(d), false, String(d));
  });
});

// MOBILISE (2026-11-23): its privacy and terms pages are src/<slug>/index.njk. The cookie policy went to docs/ and was a 404 on the site.
describe('deriveLegalTarget — a folder per page (MOBILISE)', () => {
  const site = SITE({ '/terms': { file: 'src/terms/index.njk' }, '/privacy-policy': { file: 'src/privacy-policy/index.njk' }, '/': { file: 'src/index.njk' } });
  const files = { 'src/privacy-policy/index.njk': '---\nlayout: base.njk\ntitle: "Privacy"\n---\nBody', 'src/terms/index.njk': '---\ntitle: "Terms"\n---\nBody' };
  test('a cookie policy goes beside them with their URL shape', async () => {
    const t = await deriveLegalTarget(site, 'cookie-policy', { readFile: reader(files) });
    assert.equal(t.filePath, 'src/cookie-policy/index.njk');
    assert.equal(t.permalink, '/cookie-policy/');
  });
  test('the layout comes from the first legal page that declares one, not from whichever sibling set the shape', async () => {
    const t = await deriveLegalTarget(site, 'cookie-policy', { readFile: reader(files) });
    assert.equal(t.layout, 'base.njk');
  });
  test('the home page and other pages are never taken for a legal sibling', async () => {
    const t = await deriveLegalTarget(SITE({ '/': { file: 'src/index.njk' }, '/about': { file: 'src/about/index.njk' } }), 'cookie-policy', { readFile: reader({}) });
    assert.equal(t, null);
  });
  test('terms-of-service lands as /terms/ beside the privacy page', async () => {
    const t = await deriveLegalTarget(SITE({ '/privacy-policy': { file: 'src/privacy-policy/index.njk' } }), 'terms-of-service', { readFile: reader({}) });
    assert.deepEqual([t.filePath, t.permalink], ['src/terms/index.njk', '/terms/']);
  });
  test('an existing file at the derived path is reported, never overwritten', async () => {
    const t = await deriveLegalTarget(site, 'cookie-policy', { readFile: reader({ ...files, 'src/cookie-policy/index.njk': 'already here' }) });
    assert.deepEqual(t, { conflict: true, filePath: 'src/cookie-policy/index.njk' });
  });
});

describe('deriveLegalTarget — flat files, nested URLs, and nothing to learn from', () => {
  test('a flat privacy file gives a flat cookie file', async () => {
    const t = await deriveLegalTarget(SITE({ '/privacy-policy/': { file: 'src/pages/privacy-policy.njk' } }), 'cookie-policy', { readFile: reader({}) });
    assert.deepEqual([t.filePath, t.permalink], ['src/pages/cookie-policy.njk', '/cookie-policy/']);
  });
  test('a legal page under a URL folder keeps that folder', async () => {
    const t = await deriveLegalTarget(SITE({ '/legal/privacy': { file: 'src/legal/privacy/index.md' } }), 'cookie-policy', { readFile: reader({}) });
    assert.deepEqual([t.filePath, t.permalink], ['src/legal/cookie-policy/index.md', '/legal/cookie-policy/']);
  });
  test('a site with no legal page returns null so the configured target is kept', async () => {
    assert.equal(await deriveLegalTarget(SITE({ '/': { file: 'src/index.njk' } }), 'cookie-policy', { readFile: reader({}) }), null);
    assert.equal(await deriveLegalTarget({ id: 1 }, 'cookie-policy', {}), null);
  });
  test('a sibling whose file name does not follow its URL is not guessed from', async () => {
    assert.equal(await deriveLegalTarget(SITE({ '/privacy-policy': { file: 'src/pages/legal.njk' } }), 'cookie-policy', { readFile: reader({}) }), null);
  });
  test('the cookie policy itself is never its own sibling', async () => {
    assert.equal(await deriveLegalTarget(SITE({ '/cookie-policy': { file: 'src/cookie-policy/index.njk' } }), 'cookie-policy', { readFile: reader({}) }), null);
  });
});
