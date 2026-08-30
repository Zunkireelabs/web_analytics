import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './content-integrity-repair.js';

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
