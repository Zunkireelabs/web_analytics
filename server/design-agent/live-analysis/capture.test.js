import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCardHeavyPages, discoverPages } from './capture.js';

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

// captureSite's responsive pass. A fake Browser this time, not just a Page:
// what matters is that each extra viewport gets its OWN context (a context's
// viewport is fixed at creation, so reusing the desktop one would measure
// desktop layout and report every site as perfectly responsive), that the
// contexts are closed, and that a failure to measure one page never loses the
// rest of the capture.
function fakeBrowser({ homepageLinks = [], blocksByUrl = {}, measureByViewport = {}, onContext = () => {} } = {}) {
  const closed = [];
  return {
    contexts: [],
    async newContext(opts) {
      const width = opts.viewport.width;
      onContext(opts);
      const ctx = {
        width,
        async newPage() { return makePage(width); },
        async close() { closed.push(width); },
      };
      this.contexts.push(ctx);
      return ctx;
    },
    async close() {},
    closedWidths: closed,
  };

  function makePage(width) {
    let currentUrl = null;
    return {
      async goto(url) { currentUrl = url; },
      async evaluate(fn, arg) {
        if (fn.name === 'collectLinksInPage') return homepageLinks;
        if (fn.name === 'extractBlocksInPage') {
          const fixture = blocksByUrl[currentUrl];
          if (!fixture) throw new Error(`no fixture for ${currentUrl}`);
          return fixture;
        }
        if (fn.name === 'measureResponsiveInPage') {
          const perViewport = measureByViewport[width];
          if (!perViewport) throw new Error(`no measurement fixture for viewport ${width}`);
          const m = perViewport[currentUrl];
          if (m instanceof Error) throw m;
          return { ...m, viewportWidth: width, minTapTargetPx: arg };
        }
        throw new Error(`unexpected evaluate() call: ${fn.name}`);
      },
    };
  }
}

describe('captureSite — responsive pass', () => {
  const HOME = 'https://example.com/';
  const baseBlocks = { title: 'Home', blocks: [{ cardLike: false }] };
  const measurement = (over = {}) => ({ overflowPx: 0, blocks: [], smallTapTargets: [], clippedElements: [], ...over });

  async function run(overrides = {}) {
    const { captureSite } = await import('./capture.js');
    const seenViewports = [];
    const browser = fakeBrowser({
      homepageLinks: [],
      blocksByUrl: { [HOME]: baseBlocks },
      measureByViewport: {
        1440: { [HOME]: measurement({ blocks: [{ order: 0, columns: 3 }] }) },
        834: { [HOME]: measurement() },
        390: { [HOME]: measurement({ overflowPx: 120, blocks: [{ order: 0, columns: 3 }] }) },
      },
      onContext: (opts) => seenViewports.push(opts),
      ...overrides,
    });
    const result = await captureSite(HOME, { launchBrowserFn: async () => browser, extraCardPages: 0 });
    return { result, seenViewports, browser };
  }

  test('measures the page at desktop, tablet and mobile', async () => {
    const { result } = await run();
    const measured = result.responsive.pages[0].byViewport;
    assert.deepEqual(Object.keys(measured).sort(), ['desktop', 'mobile', 'tablet']);
    assert.equal(measured.mobile.overflowPx, 120);
    assert.equal(measured.desktop.viewportWidth, 1440);
  });

  test('creates a separate context per extra viewport, with touch emulation below 768px', async () => {
    const { seenViewports } = await run();
    const widths = seenViewports.map((v) => v.viewport.width);
    assert.deepEqual(widths, [1440, 834, 390]);
    const mobile = seenViewports.find((v) => v.viewport.width === 390);
    assert.equal(mobile.isMobile, true);
    assert.equal(mobile.hasTouch, true);
    const tablet = seenViewports.find((v) => v.viewport.width === 834);
    assert.equal(tablet.isMobile, false, '834px is a tablet in landscape-capable portrait, not a phone');
  });

  test('closes every extra context it opened', async () => {
    const { browser } = await run();
    assert.deepEqual(browser.closedWidths.sort((a, b) => a - b), [390, 834]);
  });

  test('the existing desktop page capture is unchanged and still returned', async () => {
    const { result } = await run();
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].url, HOME);
    assert.equal(result.pages[0].pageType, 'homepage');
  });

  test('a viewport that fails to measure one page never loses the other viewports', async () => {
    const { result } = await run({
      measureByViewport: {
        1440: { [HOME]: measurement() },
        834: { [HOME]: new Error('navigation timeout') },
        390: { [HOME]: measurement({ overflowPx: 40 }) },
      },
    });
    const measured = result.responsive.pages[0].byViewport;
    assert.deepEqual(Object.keys(measured).sort(), ['desktop', 'mobile']);
    assert.equal(measured.mobile.overflowPx, 40);
  });

  test('responsiveMaxPages: 0 skips the responsive pass entirely', async () => {
    const { captureSite } = await import('./capture.js');
    const browser = fakeBrowser({ homepageLinks: [], blocksByUrl: { [HOME]: baseBlocks }, measureByViewport: {} });
    const result = await captureSite(HOME, { launchBrowserFn: async () => browser, extraCardPages: 0, responsiveMaxPages: 0 });
    assert.deepEqual(result.responsive.pages, []);
    assert.equal(result.pages.length, 1, 'the design profile capture still happens');
  });
});

// A fake Page whose collectLinksInPage result depends on which URL was last
// navigated to — discoverPages' second hop visits the listing page and reads
// ITS links, so a single fixed link list can't exercise that path.
function fakePagePerUrl(linksByUrl, { failOn = [] } = {}) {
  let currentUrl = null;
  return {
    navigations: [],
    async goto(url) {
      if (failOn.includes(url)) throw new Error(`nav failed: ${url}`);
      currentUrl = url;
      this.navigations.push(url);
    },
    async evaluate(fn) {
      if (fn.name !== 'collectLinksInPage') throw new Error(`unexpected evaluate(): ${fn.name}`);
      return linksByUrl[currentUrl] || [];
    },
  };
}

describe('discoverPages — second hop for blog-article', () => {
  const HOME = 'https://example.com/';

  test('follows the blog listing to capture a real article when the homepage links only to the listing', async () => {
    const page = fakePagePerUrl({
      [HOME]: ['/blog/', '/services/web/'],
      'https://example.com/blog/': ['/blog/a-real-post/', '/blog/another-post/'],
    });
    const pages = await discoverPages(page, HOME);
    const byType = Object.fromEntries(pages.map((p) => [p.pageType, p.url]));

    assert.equal(byType['blog-listing'], 'https://example.com/blog/');
    assert.equal(byType['blog-article'], 'https://example.com/blog/a-real-post/',
      'the first real article on the listing must be sampled — without it the profile has no blog-article typography');
  });

  test('does not make the extra navigation when an article was already found from the homepage', async () => {
    const page = fakePagePerUrl({
      [HOME]: ['/blog/', '/blog/already-linked/'],
    });
    await discoverPages(page, HOME);
    assert.ok(!page.navigations.includes('https://example.com/blog/'),
      'the listing must not be re-visited when blog-article already has a representative');
  });

  test('a site with no blog listing at all is untouched', async () => {
    const page = fakePagePerUrl({ [HOME]: ['/services/web/', '/contact/'] });
    const pages = await discoverPages(page, HOME);
    assert.ok(!pages.some((p) => p.pageType === 'blog-article'));
    assert.equal(page.navigations.length, 1, 'only the homepage is visited');
  });

  test('an unreachable listing page leaves the type unrepresented instead of throwing', async () => {
    const page = fakePagePerUrl(
      { [HOME]: ['/blog/'] },
      { failOn: ['https://example.com/blog/'] }
    );
    const pages = await discoverPages(page, HOME);
    assert.ok(!pages.some((p) => p.pageType === 'blog-article'));
    assert.ok(pages.some((p) => p.pageType === 'blog-listing'));
  });

  test('a listing whose links are all non-article leaves the type unrepresented', async () => {
    const page = fakePagePerUrl({
      [HOME]: ['/blog/'],
      'https://example.com/blog/': ['/contact/', '/about/'],
    });
    const pages = await discoverPages(page, HOME);
    assert.ok(!pages.some((p) => p.pageType === 'blog-article'));
  });
});

// The chayceproperties.com finding: ten of its real fourteen pages classify
// 'other', including all four of its service-package pages — as commercially
// central to that site as any named type — and two more real pages
// (/faq/, /news/) are never linked from the homepage at all.
describe('discoverPages — the "other" bucket and knownUrls (chayceproperties.com)', () => {
  const HOME = 'https://chayceproperties.com/';
  // The site's REAL homepage link order, captured live 2026-09-17.
  const CHAYCE_HOME_LINKS = [
    '/how-it-works/', '/our-services/', '/about-chayce/', '/contact/', '/get-started/',
    '/packages/', '/discovery/', '/bronze-essentials/', '/silver-comfort/', '/gold-prestige/',
    '/platinum-bespoke/', 'tel:07708925432', 'mailto:info@chayceproperties.com',
  ];

  test('multiple "other" pages are captured, not just the first — including the package-tier pages', async () => {
    const page = fakePagePerUrl({ [HOME]: CHAYCE_HOME_LINKS });
    const pages = await discoverPages(page, HOME, { maxPages: 20 });
    const otherUrls = pages.filter((p) => p.pageType === 'other').map((p) => p.url);

    assert.ok(otherUrls.length > 1, 'the old behaviour kept exactly one "other" page — this must keep more');
    for (const tier of ['bronze-essentials', 'silver-comfort', 'gold-prestige', 'platinum-bespoke']) {
      assert.ok(otherUrls.some((u) => u.includes(tier)), `${tier} must be one of the captured "other" pages`);
    }
  });

  // /our-services/ classifies 'other' too (classifyPageType's 'service'
  // pattern requires a literal "/service(s)" path segment — "our-services"
  // doesn't have one) — none of Chayce's 14 real pages actually hit a named
  // bucket besides homepage/faq/blog-listing. Confirmed directly against
  // schema.js's classifyPageType, not assumed.
  test('"other" is bounded only by the overall maxPages budget, not a fixed sub-limit', async () => {
    const page = fakePagePerUrl({ [HOME]: CHAYCE_HOME_LINKS });
    const pages = await discoverPages(page, HOME, { maxPages: 20 });
    const byType = {};
    for (const p of pages) byType[p.pageType] = (byType[p.pageType] || 0) + 1;
    // 11 of Chayce's real links classify 'other' — all of them fit given
    // enough overall budget, order no longer excludes the last few.
    assert.equal(byType.other, 11);
    assert.equal(byType.homepage, 1);
  });

  test('a tight maxPages still bounds "other" — it competes for the shared budget, not an unlimited crawl', async () => {
    const page = fakePagePerUrl({ [HOME]: CHAYCE_HOME_LINKS });
    const pages = await discoverPages(page, HOME, { maxPages: 3 });
    assert.equal(pages.length, 3);
  });

  test('every NAMED (non-"other") type still stays capped at one, even with room to spare', async () => {
    const page = fakePagePerUrl({ [HOME]: ['/faq/', '/faq-alt-example/'] });
    const pages = await discoverPages(page, HOME, { maxPages: 20 });
    const faqUrls = pages.filter((p) => p.pageType === 'faq');
    assert.equal(faqUrls.length, 1, 'faq is a single-slot bucket, unlike "other"');
    assert.equal(faqUrls[0].url, 'https://chayceproperties.com/faq/', 'the first one found');
  });

  test('maxPages still bounds the TOTAL across every bucket combined', async () => {
    const page = fakePagePerUrl({ [HOME]: CHAYCE_HOME_LINKS });
    const pages = await discoverPages(page, HOME, { maxPages: 4 });
    assert.ok(pages.length <= 4);
  });

  test('knownUrls fills in a page never linked from the homepage at all', async () => {
    // /faq/ and /news/ are real pages on chayceproperties.com that appear in
    // NEITHER CHAYCE_HOME_LINKS above (confirmed against the live site) —
    // no crawl depth from the homepage can find them.
    const page = fakePagePerUrl({ [HOME]: CHAYCE_HOME_LINKS });
    const pages = await discoverPages(page, HOME, {
      maxPages: 20,
      knownUrls: ['https://chayceproperties.com/faq/', 'https://chayceproperties.com/news/'],
    });
    assert.ok(pages.some((p) => p.pageType === 'faq' && p.url.includes('/faq/')));
    assert.ok(pages.some((p) => p.pageType === 'blog-listing' && p.url.includes('/news/')));
  });

  test('knownUrls never bypasses the per-type limit — a crawled example still wins the slot', async () => {
    const page = fakePagePerUrl({ [HOME]: ['/faq/'] });
    const pages = await discoverPages(page, HOME, {
      maxPages: 20,
      knownUrls: ['https://chayceproperties.com/help/'], // also classifies 'faq'
    });
    const faqUrls = pages.filter((p) => p.pageType === 'faq');
    assert.equal(faqUrls.length, 1, 'faq is a single-slot bucket regardless of source');
    assert.equal(faqUrls[0].url, 'https://chayceproperties.com/faq/', 'the real crawled one, found first');
  });

  test('knownUrls is additive within maxPages, never forcing the total over it', async () => {
    const page = fakePagePerUrl({ [HOME]: ['/how-it-works/'] });
    const pages = await discoverPages(page, HOME, {
      maxPages: 2, // homepage + one more, no room for both known URLs
      knownUrls: ['https://chayceproperties.com/faq/', 'https://chayceproperties.com/news/'],
    });
    assert.equal(pages.length, 2);
  });
});
