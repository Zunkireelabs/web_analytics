import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCardHeavyPages } from './capture.js';

// A fake Playwright Page — goto/evaluate are the only two methods
// discoverCardHeavyPages and the capturePage() it calls internally use.
// `evaluate` is called with the real in-page function reference
// (collectLinksInPage or extractBlocksInPage); since this never runs in an
// actual browser, we key off which one it is by name rather than executing
// it, and hand back canned per-URL fixtures keyed by whatever URL the most
// recent `goto` navigated to.
function fakePage({ homepageLinks, blocksByUrl }) {
  let currentUrl = null;
  return {
    async goto(url) { currentUrl = url; },
    async evaluate(fn) {
      if (fn.name === 'collectLinksInPage') return homepageLinks;
      if (fn.name === 'extractBlocksInPage') {
        const fixture = blocksByUrl[currentUrl];
        if (!fixture) throw new Error(`no fixture for ${currentUrl}`);
        return fixture;
      }
      throw new Error(`unexpected evaluate() call: ${fn.name}`);
    },
  };
}

describe('discoverCardHeavyPages', () => {
  test('keeps a page with 2+ card-shaped blocks, skips one with fewer', () => {
    const page = fakePage({
      homepageLinks: ['/projects/', '/about/'],
      blocksByUrl: {
        'https://example.com/projects/': { title: 'Projects', blocks: [{ cardLike: true }, { cardLike: true }, { cardLike: false }] },
        'https://example.com/about/': { title: 'About', blocks: [{ cardLike: true }, { cardLike: false }] },
      },
    });
    return discoverCardHeavyPages(page, 'https://example.com/', []).then((found) => {
      assert.deepEqual(found.map((f) => f.url), ['https://example.com/projects/']);
      assert.equal(found[0].pageType, 'other');
    });
  });

  test('excludes URLs already captured by the normal type-based pass', () => {
    const page = fakePage({
      homepageLinks: ['/projects/'],
      blocksByUrl: { 'https://example.com/projects/': { title: 'Projects', blocks: [{ cardLike: true }, { cardLike: true }] } },
    });
    return discoverCardHeavyPages(page, 'https://example.com/', ['https://example.com/projects/']).then((found) => {
      assert.deepEqual(found, []);
    });
  });

  test('never returns more than maxFound, even with more candidates', () => {
    const page = fakePage({
      homepageLinks: ['/a/', '/b/', '/c/'],
      blocksByUrl: {
        'https://example.com/a/': { title: 'A', blocks: [{ cardLike: true }, { cardLike: true }] },
        'https://example.com/b/': { title: 'B', blocks: [{ cardLike: true }, { cardLike: true }] },
        'https://example.com/c/': { title: 'C', blocks: [{ cardLike: true }, { cardLike: true }] },
      },
    });
    return discoverCardHeavyPages(page, 'https://example.com/', [], { maxFound: 2, scanBudget: 10 }).then((found) => {
      assert.equal(found.length, 2);
    });
  });

  test('stops scanning once scanBudget page loads are attempted, even if nothing matched yet', () => {
    let loads = 0;
    const page = fakePage({
      homepageLinks: ['/a/', '/b/', '/c/', '/d/'],
      blocksByUrl: {
        'https://example.com/a/': { title: 'A', blocks: [{ cardLike: false }] },
        'https://example.com/b/': { title: 'B', blocks: [{ cardLike: false }] },
        'https://example.com/c/': { title: 'C', blocks: [{ cardLike: false }] },
        'https://example.com/d/': { title: 'D', blocks: [{ cardLike: true }, { cardLike: true }] },
      },
    });
    const countedGoto = page.goto.bind(page);
    page.goto = async (url) => { if (url !== 'https://example.com/') loads++; return countedGoto(url); };
    return discoverCardHeavyPages(page, 'https://example.com/', [], { maxFound: 5, scanBudget: 2 }).then((found) => {
      assert.equal(loads, 2, 'must not scan past the budget');
      assert.deepEqual(found, [], 'the only card-heavy page (d) sits past the 2-page scan budget');
    });
  });

  test('skips a candidate whose capture fails, and keeps scanning the rest', () => {
    const page = fakePage({
      homepageLinks: ['/broken/', '/projects/'],
      blocksByUrl: { 'https://example.com/projects/': { title: 'Projects', blocks: [{ cardLike: true }, { cardLike: true }] } },
    });
    // No fixture registered for /broken/ — the fake's evaluate() throws for
    // it, exactly like a real navigation failure would reject capturePage().
    return discoverCardHeavyPages(page, 'https://example.com/', []).then((found) => {
      assert.deepEqual(found.map((f) => f.url), ['https://example.com/projects/']);
    });
  });
});
