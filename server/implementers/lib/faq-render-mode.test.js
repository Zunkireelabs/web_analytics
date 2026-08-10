import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countCurrentlyVisibleFaqPages } from './faq-render-mode.js';

function siteWithPages(pages) {
  const url_file_map = { pages: {} };
  for (const p of pages) url_file_map.pages[p] = { file: `src/pages/${p.replace(/\W+/g, '_')}.njk` };
  return { id: 1, visible_faq_baseline: 0, url_file_map };
}

describe('countCurrentlyVisibleFaqPages', () => {
  test('counts a page only if its CURRENT live content still shows a visible FAQ signal', async () => {
    const site = siteWithPages(['/a/', '/b/']);
    const listPages = async () => ['/a/', '/b/'];
    // /a/ still has a real Q&A loop (strong visible signal), /b/'s FAQ was
    // removed since — its current content has nothing left.
    const fetchFile = async (s, filePath) => {
      if (filePath.includes('_a_')) return { content: '{% for item in faq %}{{ item.question }}{{ item.answer }}{% endfor %}' };
      return { content: '<p>just a plain page now</p>' };
    };
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 1);
  });

  test('a page whose FAQ was removed does not count, even though it was historically pushed as visible', async () => {
    const site = siteWithPages(['/a/']);
    const listPages = async () => ['/a/'];
    const fetchFile = async () => ({ content: '<p>no faq here anymore</p>' });
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 0);
  });

  test('a page whose file no longer exists live does not count', async () => {
    const site = siteWithPages(['/a/']);
    const listPages = async () => ['/a/'];
    const fetchFile = async () => null;
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 0);
  });

  test('a page no longer mapped in url_file_map at all does not count', async () => {
    const site = siteWithPages([]);
    const listPages = async () => ['/gone/'];
    const fetchFile = async () => { throw new Error('should never be called — page has no file mapping'); };
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 0);
  });

  test('adds the organic visible_faq_baseline on top of the live-verified drafted count', async () => {
    const site = { ...siteWithPages(['/a/']), visible_faq_baseline: 3 };
    const listPages = async () => ['/a/'];
    const fetchFile = async () => ({ content: '{% for item in faq %}{{ item.question }}{{ item.answer }}{% endfor %}' });
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 4);
  });

  test('a page dropping below the cap frees up a slot again (regression check for the historical-count bug)', async () => {
    // Cap of 2: /a/ still visible, /b/'s FAQ was removed since it was pushed.
    // The historical count (2 pages ever pushed) would wrongly say "at cap".
    // The live-verified count (1 still visible) correctly says there's room.
    const site = { ...siteWithPages(['/a/', '/b/']), visible_faq_cap: 2 };
    const listPages = async () => ['/a/', '/b/'];
    const fetchFile = async (s, filePath) => {
      if (filePath.includes('_a_')) return { content: '{% for item in faq %}{{ item.question }}{{ item.answer }}{% endfor %}' };
      return { content: '<p>removed</p>' };
    };
    const count = await countCurrentlyVisibleFaqPages(site, { listPages, fetchFile });
    assert.equal(count, 1);
    assert.ok(count < site.visible_faq_cap, 'a freed-up slot must be reflected as room under the cap');
  });
});
