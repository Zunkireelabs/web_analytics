import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRedirectLoop, detectHeadingOrderSkips, detectNoOutgoingLinks, detectDuplicateMetaDescriptions,
} from './audit-gap-checks.js';

describe('redirect loop', () => {
  test('a chain that arrives somewhere is not a loop', () => {
    assert.deepEqual(detectRedirectLoop(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']), { loop: false });
  });

  test('a page redirecting to itself is a loop', () => {
    const out = detectRedirectLoop(['https://a.com/x', 'https://a.com/x']);
    assert.equal(out.loop, true);
    assert.deepEqual(out.cycle, ['a.com/x', 'a.com/x']);
  });

  test('a longer cycle is found and reported from its start', () => {
    const out = detectRedirectLoop(['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://a.com/2']);
    assert.equal(out.loop, true);
    assert.equal(out.repeatedUrl, 'a.com/2');
    assert.deepEqual(out.cycle, ['a.com/2', 'a.com/3', 'a.com/2']);
  });

  test('a scheme-and-slash loop is caught, which a literal comparison would miss', () => {
    const out = detectRedirectLoop(['http://a.com/a', 'https://a.com/a/', 'http://www.a.com/a']);
    assert.equal(out.loop, true);
  });

  test('a query string makes a different URL, so it is not a loop', () => {
    assert.equal(detectRedirectLoop(['https://a.com/x', 'https://a.com/x?p=1']).loop, false);
  });

  test('empty and junk input is handled', () => {
    for (const input of [[], null, undefined, ['not a url']]) {
      assert.equal(detectRedirectLoop(input).loop, false);
    }
  });
});

describe('heading order', () => {
  test('a sound outline has no skips', () => {
    const out = detectHeadingOrderSkips([{ level: 1 }, { level: 2 }, { level: 3 }, { level: 2 }]);
    assert.deepEqual(out.skips, []);
  });

  test('H1 straight to H3 is a skip, and names both levels', () => {
    const out = detectHeadingOrderSkips([{ level: 1, text: 'Title' }, { level: 3, text: 'Jumped' }]);
    assert.deepEqual(out.skips, [{ from: 'h1', to: 'h3', text: 'Jumped' }]);
  });

  test('going back up a level is normal, not a defect', () => {
    assert.deepEqual(detectHeadingOrderSkips([{ level: 1 }, { level: 3 }, { level: 2 }]).skips.length, 1,
      'only the h1->h3 descent counts');
  });

  test('tag names are accepted as well as numeric levels', () => {
    const out = detectHeadingOrderSkips([{ tag: 'h1' }, { tag: 'H4', text: 'Deep' }]);
    assert.deepEqual(out.skips, [{ from: 'h1', to: 'h4', text: 'Deep' }]);
  });

  test('a page whose outline starts deep is not reported here', () => {
    // Starting at h2 is "missing H1", which is already covered elsewhere.
    assert.deepEqual(detectHeadingOrderSkips([{ level: 2 }, { level: 3 }]).skips, []);
  });

  test('several skips are all reported', () => {
    const out = detectHeadingOrderSkips([{ level: 1 }, { level: 3 }, { level: 4 }, { level: 6 }]);
    assert.deepEqual(out.skips.map((s) => `${s.from}->${s.to}`), ['h1->h3', 'h4->h6']);
  });

  test('unrecognised entries are ignored, not guessed at', () => {
    const out = detectHeadingOrderSkips([{ level: 1 }, { tag: 'div' }, { level: 2 }, null]);
    assert.deepEqual(out.skips, []);
  });

  test('empty input is sound', () => {
    assert.deepEqual(detectHeadingOrderSkips([]).skips, []);
    assert.deepEqual(detectHeadingOrderSkips(null).skips, []);
  });
});

describe('no outgoing internal links', () => {
  test('a page with real internal links is fine', () => {
    const out = detectNoOutgoingLinks('https://a.com/page', ['https://a.com/other', 'https://a.com/third']);
    assert.equal(out.deadEnd, false);
    assert.equal(out.outgoingCount, 2);
  });

  test('a page with no links at all is a dead end', () => {
    assert.equal(detectNoOutgoingLinks('https://a.com/page', []).deadEnd, true);
    assert.equal(detectNoOutgoingLinks('https://a.com/page', null).deadEnd, true);
  });

  test('links only to itself do not count as going anywhere', () => {
    const out = detectNoOutgoingLinks('https://a.com/page', ['https://a.com/page', 'https://a.com/page/']);
    assert.equal(out.deadEnd, true);
  });

  test('fragment-only links do not count', () => {
    assert.equal(detectNoOutgoingLinks('https://a.com/page', ['#top', '#section-2']).deadEnd, true);
  });

  test('duplicate links count once', () => {
    const out = detectNoOutgoingLinks('https://a.com/page', ['https://a.com/x', 'https://a.com/x/']);
    assert.equal(out.outgoingCount, 1);
  });

  test('link objects are accepted as well as strings', () => {
    const out = detectNoOutgoingLinks('https://a.com/page', [{ href: 'https://a.com/other' }]);
    assert.equal(out.outgoingCount, 1);
  });

  test('ignored paths do not rescue a dead end', () => {
    const out = detectNoOutgoingLinks('https://a.com/page', ['https://a.com/privacy'], { ignorePaths: ['/privacy'] });
    assert.equal(out.deadEnd, true, 'a link only to boilerplate is still a dead end');
  });
});

describe('duplicate meta descriptions', () => {
  const page = (url, metaDescription) => ({ url, metaDescription });
  const long = 'A clear description of this page that is comfortably past the minimum length.';

  test('two pages sharing a description are reported together', () => {
    const out = detectDuplicateMetaDescriptions([page('/a', long), page('/b', long), page('/c', `${long} Different.`)]);
    assert.equal(out.duplicates.length, 1);
    assert.deepEqual(out.duplicates[0].urls, ['/a', '/b']);
    assert.equal(out.duplicates[0].count, 2);
  });

  test('case and spacing differences are still the same snippet', () => {
    const out = detectDuplicateMetaDescriptions([page('/a', long), page('/b', `  ${long.toUpperCase()}  `)]);
    assert.equal(out.duplicates.length, 1);
  });

  test('unique descriptions report nothing', () => {
    const out = detectDuplicateMetaDescriptions([page('/a', `${long} One.`), page('/b', `${long} Two.`)]);
    assert.deepEqual(out.duplicates, []);
  });

  test('missing descriptions are not reported here — that is a different issue', () => {
    const out = detectDuplicateMetaDescriptions([page('/a', ''), page('/b', null), page('/c')]);
    assert.deepEqual(out.duplicates, []);
  });

  test('a very short description is ignored rather than grouped', () => {
    assert.deepEqual(detectDuplicateMetaDescriptions([page('/a', 'Home'), page('/b', 'Home')]).duplicates, []);
  });

  test('the same page listed twice is not a duplicate of itself', () => {
    const out = detectDuplicateMetaDescriptions([page('/a', long), page('/a', long)]);
    assert.deepEqual(out.duplicates, []);
  });

  test('the worst offender is reported first', () => {
    const a = `${long} A.`;
    const b = `${long} B.`;
    const out = detectDuplicateMetaDescriptions([
      page('/1', a), page('/2', a),
      page('/3', b), page('/4', b), page('/5', b),
    ]);
    assert.deepEqual(out.duplicates.map((d) => d.count), [3, 2]);
  });

  test('the snake_case column name is accepted too', () => {
    const out = detectDuplicateMetaDescriptions([
      { url: '/a', meta_description: long }, { url: '/b', meta_description: long },
    ]);
    assert.equal(out.duplicates.length, 1);
  });

  test('empty and junk input is handled', () => {
    assert.deepEqual(detectDuplicateMetaDescriptions([]).duplicates, []);
    assert.deepEqual(detectDuplicateMetaDescriptions(null).duplicates, []);
    assert.deepEqual(detectDuplicateMetaDescriptions([null, {}]).duplicates, []);
  });
});
