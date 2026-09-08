import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// mock.module (same convention as design-drift.test.js/auto-remediation.test.js)
// swaps out store/read.js's getSiteById so the raw-text-table styling tests
// below can control exactly what design profile — real, none, or absent —
// the generator sees, without a live DB connection. `siteFixture` is
// reassigned per-test; every OTHER describe block in this file never sets
// it, so getSiteById resolves to `undefined` for them, and buildTableHtml's
// styles argument stays null — the same unstyled-fallback behavior those
// tests already asserted before table styling existed.
const resolve = (p) => new URL(p, import.meta.url).href;
let siteFixture;
mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => siteFixture },
});

const { generate, meta } = await import('./content-integrity-repair.js');

function stubFetchHtml(html) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html,
    url,
  });
  return () => { globalThis.fetch = original; };
}

const GROUNDING = '<main><p>' + 'Real page content that is long enough to pass grounding checks. '.repeat(4) + '</p></main>';

describe('content-integrity-repair generator', () => {
  test('requires page and fixType', async () => {
    await assert.rejects(() => generate({ params: {} }));
    await assert.rejects(() => generate({ params: { page: 'https://example.com/x' } }));
  });

  test('meta.id is content-integrity-repair', () => {
    assert.equal(meta.id, 'content-integrity-repair');
  });

  test('rejects an unknown fixType', async () => {
    const restore = stubFetchHtml(`<html><body>${GROUNDING}</body></html>`);
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/x', fixType: 'nope' } }),
        /unknown content-integrity fixtype/i,
      );
    } finally { restore(); }
  });
});

describe('content-integrity-repair — malformed-table', () => {
  test('removes an empty table shell', async () => {
    const restore = stubFetchHtml(`<html><body>${GROUNDING}<table></table></body></html>`);
    try {
      const { content, summary } = await generate({ params: { page: 'https://example.com/t', fixType: 'malformed-table' } });
      assert.equal(content.fixType, 'malformed-table');
      assert.equal(content.reason, 'no-rows');
      assert.equal(content.anchorHtml, '<table></table>');
      assert.equal(content.replacement, '');
      assert.match(summary, /empty/i);
    } finally { restore(); }
  });

  test('removes a broken empty row, keeping the rest of the anchor intact', async () => {
    const restore = stubFetchHtml(
      `<html><body>${GROUNDING}<table><tr><td>a</td><td>b</td></tr><tr></tr></table></body></html>`,
    );
    try {
      const { content } = await generate({ params: { page: 'https://example.com/t', fixType: 'malformed-table' } });
      assert.equal(content.reason, 'empty-row');
      assert.equal(content.anchorHtml, '<tr></tr>');
    } finally { restore(); }
  });

  test('refuses when no broken table is on the page', async () => {
    const restore = stubFetchHtml(`<html><body>${GROUNDING}<table><tr><td>a</td></tr></table></body></html>`);
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/t', fixType: 'malformed-table' } }),
        /no safely-removable broken table markup/i,
      );
    } finally { restore(); }
  });

  test('refuses a genuine column-mismatch table — no safe removal fix for real misaligned data', async () => {
    const html = `<html><body>${GROUNDING}<table>
      <tr><th>Name</th><th>Q1</th><th>Q2</th></tr>
      <tr><td>Alice</td><td>10</td><td>20</td></tr>
      <tr><td>Bob</td><td>15</td></tr>
    </table></body></html>`;
    const restore = stubFetchHtml(html);
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/t', fixType: 'malformed-table' } }),
        /no safely-removable broken table markup/i,
      );
    } finally { restore(); }
  });

  test('does not false-positive a well-formed colspan/rowspan table as broken', async () => {
    const html = `<html><body>${GROUNDING}<table>
      <tr><th>Name</th><th>Q1</th><th>Q2</th></tr>
      <tr><td rowspan="2">Alice</td><td>10</td><td>20</td></tr>
      <tr><td>15</td><td>25</td></tr>
      <tr><td colspan="3">Total: 70</td></tr>
    </table></body></html>`;
    const restore = stubFetchHtml(html);
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/t', fixType: 'malformed-table' } }),
        /no safely-removable broken table markup/i,
      );
    } finally { restore(); }
  });
});

describe('content-integrity-repair — raw-text-table', () => {
  test('rebuilds a clean pipe-delimited block into a real table, preserving the exact real text', async () => {
    const raw = 'Feature | Plan A | Plan B\nPrice | $10 | $20\nSupport | Email | Phone';
    const restore = stubFetchHtml(`<html><body>${GROUNDING}<p>${raw}</p></body></html>`);
    try {
      const { content, summary } = await generate({ params: { page: 'https://example.com/r', fixType: 'raw-text-table' } });
      assert.equal(content.fixType, 'raw-text-table');
      assert.match(content.anchorHtml, /<p>Feature/);
      assert.match(content.replacement, /<table>/);
      assert.match(content.replacement, /<th>Feature<\/th>/);
      assert.match(content.replacement, /<td>\$10<\/td>/);
      assert.deepEqual(content.rows[0], ['Feature', 'Plan A', 'Plan B']);
      assert.match(summary, /real table/i);
    } finally { restore(); }
  });

  test('preserves a real lead-in sentence sharing the paragraph with the table, converting only the table rows', async () => {
    const html = 'Here is a breakdown of the key differences:\n'
      + '| Feature | AI-Native Search | Traditional Keyword Search |\n'
      + '|---|---|---|\n'
      + '| User Intent | Understands intent | Matches terms |\n'
      + '| Response Type | Direct answers | Ranked links |';
    const restore = stubFetchHtml(`<html><body>${GROUNDING}<p>${html}</p></body></html>`);
    try {
      const { content } = await generate({ params: { page: 'https://example.com/r', fixType: 'raw-text-table' } });
      assert.match(content.replacement, /<p>Here is a breakdown of the key differences:<\/p>/);
      assert.match(content.replacement, /<table>/);
      assert.match(content.replacement, /<th>Feature<\/th>/);
      assert.deepEqual(content.rows[0], ['Feature', 'AI-Native Search', 'Traditional Keyword Search']);
    } finally { restore(); }
  });

  test('refuses an irregular block (mixed prose + pipes) rather than guessing structure', async () => {
    const restore = stubFetchHtml(
      `<html><body>${GROUNDING}<p>Some prose here.\nFeature | Plan A\nMore prose in between.\nPrice | $10 | $20 | extra</p></body></html>`,
    );
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/r', fixType: 'raw-text-table' } }),
        /cleanly-structured/i,
      );
    } finally { restore(); }
  });

  // The table-capture/projectTable gap this whole exercise exists to close
  // (see design-agent/lib/design-profile.js's projectTable): before this,
  // buildTableHtml always emitted bare <table><thead><tr><th> with no site
  // styling at all, regardless of what design profile a site had. These
  // three prove the generator actually reaches into the site's own profile.
  test('a site with a REAL captured table pattern gets its own table styled with that exact pattern', async () => {
    const raw = 'Feature | Plan A | Plan B\nPrice | $10 | $20\nSupport | Email | Phone';
    const restore = stubFetchHtml(`<html><body>${GROUNDING}<p>${raw}</p></body></html>`);
    siteFixture = {
      url_file_map: { siteRoot: { designProfile: {
        components: { table: { wrapper: 'w-full acme-table', headerCell: 'acme-th', row: 'acme-row', cell: 'acme-td' } },
      } } },
    };
    try {
      const { content } = await generate({ siteId: 1, params: { page: 'https://example.com/r', fixType: 'raw-text-table' } });
      assert.match(content.replacement, /<table class="w-full acme-table">/);
      assert.match(content.replacement, /<th class="acme-th">Feature<\/th>/);
      assert.match(content.replacement, /<tr class="acme-row">/);
      assert.match(content.replacement, /<td class="acme-td">\$10<\/td>/);
      assert.match(content.replacement, /overflow-x-auto/, 'the horizontal-scroll wrapper is structural, present regardless of tenant');
    } finally { restore(); siteFixture = undefined; }
  });

  test('a site with NO captured table but real typography/color tokens gets a composed table using ONLY those tokens', async () => {
    const raw = 'Feature | Plan A | Plan B\nPrice | $10 | $20\nSupport | Email | Phone';
    const restore = stubFetchHtml(`<html><body>${GROUNDING}<p>${raw}</p></body></html>`);
    siteFixture = {
      url_file_map: { siteRoot: { designProfile: {
        typography: { body: 'text-base text-gray-700', heading: { item: 'text-sm font-semibold' } },
        color: { border: 'border-gray-200', surface: 'bg-gray-50' },
      } } },
    };
    try {
      const { content } = await generate({ siteId: 2, params: { page: 'https://example.com/r', fixType: 'raw-text-table' } });
      assert.match(content.replacement, /<th class="text-sm font-semibold bg-gray-50 text-left">/);
      assert.match(content.replacement, /<tr class="border-b border-gray-200">/);
      assert.match(content.replacement, /<td class="text-base text-gray-700 text-left">/);
      assert.doesNotMatch(content.replacement, /acme/, 'must be composed from THIS site\'s own tokens, never another tenant\'s');
    } finally { restore(); siteFixture = undefined; }
  });

  test('a site with no usable profile at all still gets a real <table>, just unstyled — never worse than before', async () => {
    const raw = 'Feature | Plan A | Plan B\nPrice | $10 | $20\nSupport | Email | Phone';
    const restore = stubFetchHtml(`<html><body>${GROUNDING}<p>${raw}</p></body></html>`);
    siteFixture = { url_file_map: { siteRoot: {} } };
    try {
      const { content } = await generate({ siteId: 3, params: { page: 'https://example.com/r', fixType: 'raw-text-table' } });
      assert.match(content.replacement, /<table>/);
      assert.match(content.replacement, /<th>Feature<\/th>/);
    } finally { restore(); siteFixture = undefined; }
  });
});

describe('content-integrity-repair — faq-schema-mismatch', () => {
  test('rebuilds FAQPage schema from the real visible Q&A pairs', async () => {
    const html = `<html><body>${GROUNDING}
      <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Old?"}]}</script>
      <details><summary>What is this?</summary>Answer one text here.</details>
      <details><summary>How does it work?</summary>Answer two text here.</details>
    </body></html>`;
    const restore = stubFetchHtml(html);
    try {
      const { content, summary } = await generate({ params: { page: 'https://example.com/f', fixType: 'faq-schema-mismatch' } });
      assert.equal(content.fixType, 'faq-schema-mismatch');
      assert.match(content.originalRaw, /"Old\?"/);
      assert.equal(content.jsonLd.mainEntity.length, 2);
      assert.equal(content.jsonLd.mainEntity[0].name, 'What is this?');
      assert.equal(content.jsonLd.mainEntity[0].acceptedAnswer.text, 'Answer one text here.');
      assert.match(summary, /resync/i);
    } finally { restore(); }
  });

  test('refuses when an answer cannot be confidently extracted for every question', async () => {
    const html = `<html><body>${GROUNDING}
      <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q?"}]}</script>
      <button>What is this?</button>
      <button>How does it work?</button>
      <p>Some unrelated paragraph, then another question follows.</p>
      <button>Is this a third question?</button>
    </body></html>`;
    const restore = stubFetchHtml(html);
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/f', fixType: 'faq-schema-mismatch' } }),
        /could not confidently extract/i,
      );
    } finally { restore(); }
  });

  test('refuses when the FAQPage schema shares a script tag with another type', async () => {
    const html = `<html><body>${GROUNDING}
      <script type="application/ld+json">{"@graph":[{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q?"}]},{"@type":"Organization","name":"Acme"}]}</script>
      <details><summary>A?</summary>ans</details>
      <details><summary>B?</summary>ans</details>
    </body></html>`;
    const restore = stubFetchHtml(html);
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/f', fixType: 'faq-schema-mismatch' } }),
        /shares a <script> tag/i,
      );
    } finally { restore(); }
  });
});

describe('content-integrity-repair — font-size-override', () => {
  test('requires outerHtml', async () => {
    await assert.rejects(
      () => generate({ params: { page: 'https://example.com/f', fixType: 'font-size-override' } }),
      /outerhtml is required/i,
    );
  });

  test('removes the inline font-size declaration, keeping the rest of the style intact', async () => {
    const { content, summary } = await generate({
      params: { page: 'https://example.com/f', fixType: 'font-size-override', outerHtml: '<h1 style="font-size: 18px; color: red;">Hi</h1>' },
    });
    assert.equal(content.fixType, 'font-size-override');
    assert.equal(content.anchorHtml, '<h1 style="font-size: 18px; color: red;">Hi</h1>');
    assert.equal(content.replacement, '<h1 style="color: red;">Hi</h1>');
    assert.match(summary, /inline font-size/i);
  });

  test('refuses when the element has no inline font-size override (a CSS-class-driven difference has no safe single-element fix)', async () => {
    await assert.rejects(
      () => generate({ params: { page: 'https://example.com/f', fixType: 'font-size-override', outerHtml: '<h1 class="hero-sm">Hi</h1>' } }),
      /no safe single-element fix/i,
    );
  });

  test('does not fetch the page at all — grounded in the live-captured outerHtml, not a static re-fetch', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('should not be called'); };
    try {
      const { content } = await generate({
        params: { page: 'https://example.com/f', fixType: 'font-size-override', outerHtml: '<h1 style="font-size: 18px;">Hi</h1>' },
      });
      assert.equal(content.replacement, '<h1>Hi</h1>');
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe('content-integrity-repair — table-style-drift / typography-drift (design-consistency routing)', () => {
  test('table-style-drift swaps only the class attribute, leaving the rest of the anchor untouched', async () => {
    const { content, summary } = await generate({
      params: {
        page: 'https://example.com/pricing', fixType: 'table-style-drift',
        sectionClasses: 'old-table plain', siteConvention: 'table w-full border',
        outerHtml: '<table class="old-table plain"><tbody><tr><td>1</td></tr></tbody></table>',
      },
    });
    assert.equal(content.fixType, 'table-style-drift');
    assert.equal(content.anchorHtml, '<table class="old-table plain"><tbody><tr><td>1</td></tr></tbody></table>');
    assert.equal(content.replacement, '<table class="table w-full border"><tbody><tr><td>1</td></tr></tbody></table>');
    assert.match(summary, /table's styling/i);
  });

  test('typography-drift swaps a heading\'s class attribute the same way', async () => {
    const { content } = await generate({
      params: {
        page: 'https://example.com/about', fixType: 'typography-drift',
        sectionClasses: 'text-sm text-gray-500', siteConvention: 'text-3xl font-bold',
        outerHtml: '<h2 class="text-sm text-gray-500">About us</h2>',
      },
    });
    assert.equal(content.replacement, '<h2 class="text-3xl font-bold">About us</h2>');
  });

  test('class-token order/whitespace differences from detection do not block the match — same tokens, different order, still matches', async () => {
    const { content } = await generate({
      params: {
        page: 'https://example.com/about', fixType: 'typography-drift',
        sectionClasses: 'text-gray-500 text-sm', // reversed order vs. the live anchor below
        siteConvention: 'text-3xl font-bold',
        outerHtml: '<p class="text-sm  text-gray-500">Body copy</p>',
      },
    });
    assert.equal(content.replacement, '<p class="text-3xl font-bold">Body copy</p>');
  });

  test('requires outerHtml', async () => {
    await assert.rejects(
      () => generate({ params: { page: 'https://example.com/x', fixType: 'table-style-drift', sectionClasses: 'a', siteConvention: 'b' } }),
      /no live-captured section markup/i,
    );
  });

  test('requires siteConvention', async () => {
    await assert.rejects(
      () => generate({ params: { page: 'https://example.com/x', fixType: 'table-style-drift', sectionClasses: 'a', outerHtml: '<table class="a"></table>' } }),
      /no real site design convention/i,
    );
  });

  test('refuses when the anchor\'s current class no longer matches what detection observed — the page changed since the scan ran', async () => {
    await assert.rejects(
      () => generate({
        params: {
          page: 'https://example.com/x', fixType: 'typography-drift',
          sectionClasses: 'stale-class', siteConvention: 'new-class',
          outerHtml: '<h2 class="a-completely-different-class">Hi</h2>',
        },
      }),
      /no longer matches what design-consistency detected/i,
    );
  });

  test('refuses when the anchor has no class attribute at all', async () => {
    await assert.rejects(
      () => generate({
        params: {
          page: 'https://example.com/x', fixType: 'table-style-drift',
          sectionClasses: 'a', siteConvention: 'b', outerHtml: '<table><tbody></tbody></table>',
        },
      }),
      /no longer matches what design-consistency detected/i,
    );
  });

  test('does not fetch the page at all — grounded in the live-captured outerHtml, same discipline as font-size-override', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('should not be called'); };
    try {
      const { content } = await generate({
        params: {
          page: 'https://example.com/x', fixType: 'table-style-drift',
          sectionClasses: 'old', siteConvention: 'new', outerHtml: '<table class="old"></table>',
        },
      });
      assert.equal(content.replacement, '<table class="new"></table>');
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe('content-integrity-repair — duplicate-faq', () => {
  test('removes the later of two containers whose questions substantially overlap', async () => {
    const html = `<html><body>${GROUNDING}
      <div class="faq-a"><button>What is X?</button><button>How does Y work?</button></div>
      <div id="faq-b"><button>What is X?</button><button>How does Y work?</button></div>
    </body></html>`;
    const restore = stubFetchHtml(html);
    try {
      const { content, summary } = await generate({ params: { page: 'https://example.com/d', fixType: 'duplicate-faq' } });
      assert.equal(content.fixType, 'duplicate-faq');
      assert.match(content.anchorHtml, /id="faq-b"/);
      assert.equal(content.replacement, '');
      assert.match(summary, /duplicate/i);
    } finally { restore(); }
  });

  test('refuses when two FAQ sections have substantially different real questions', async () => {
    const html = `<html><body>${GROUNDING}
      <div class="faq-shipping"><button>When do you ship?</button><button>What carriers do you use?</button></div>
      <div id="faq-returns"><button>Can I return items?</button><button>How long is the return window?</button></div>
    </body></html>`;
    const restore = stubFetchHtml(html);
    try {
      await assert.rejects(
        () => generate({ params: { page: 'https://example.com/d', fixType: 'duplicate-faq' } }),
        /no confirmed-duplicate/i,
      );
    } finally { restore(); }
  });
});
