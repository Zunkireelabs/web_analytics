import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { checkStyleFidelity, judgeStyleFidelity, styleFidelityMode, STYLE_CHECKED_MARKERS, describeStyleIssues } from './style-fidelity-gate.js';

const S = (o = {}) => ({ weight: 400, size: 16, color: 'rgb(0, 0, 0)', italic: 'normal', upper: 'none', ...o });
const facts = (o = {}) => ({ injected: 'marker', refFamily: 'inter', blockFamily: 'inter', pairs: [], textElements: 6, ...o });
const pair = (q = S(), a = S(), gap = 0) => ({ q, a, gap });

describe('styleFidelityMode', () => {
  test('defaults to enforce; accepts enforce, log, off; anything else is enforce', () => {
    assert.equal(styleFidelityMode({}), 'enforce');
    for (const m of ['enforce', 'log', 'off']) assert.equal(styleFidelityMode({ STYLE_FIDELITY_GATE: m }), m);
    assert.equal(styleFidelityMode({ STYLE_FIDELITY_GATE: 'maybe' }), 'enforce');
  });
});

describe('judgeStyleFidelity — type scale, colour, spacing, column and phone width', () => {
  const page = { pageSizes: [14, 16, 18, 24], pageColours: ['34,34,51', '17,17,17', '0,102,204'], pageBackgrounds: ['255,255,255', '245,247,250'], rhythm: 16 };
  const ok = (o = {}) => judgeStyleFidelity(facts({ ...page, blockSizes: [16], blockColours: ['34,34,51'], blockBackgrounds: [], gapAbove: 20, outside: { left: 0, right: 0 }, ...o }), { kind: 'prose', mobile: o.mobile ?? null });
  const types = (r) => r.issues.map((i) => i.type);
  test('a block that stays inside the page\'s own sizes, colours, spacing and column passes', () => assert.equal(ok().status, 'passed'));
  test('a font size the page never uses fails; sub-pixel differences do not', () => {
    assert.deepEqual(types(ok({ blockSizes: [11] })), ['off-scale-size']);
    assert.equal(ok({ blockSizes: [12] }).status, 'passed'); // within 2px of the page's 14: one page shows only some of the site's sizes
    assert.equal(ok({ blockSizes: [20] }).status, 'passed'); // 20px beside the page's 18px is the same scale
    assert.equal(ok({ blockSizes: [16, 18, 15] }).status, 'passed'); // 15 is within 1px of the page's 14 and 16
  });
  test('a text colour the page never uses fails; an opacity-like variant of a page colour does not', () => {
    assert.deepEqual(types(ok({ blockColours: ['255,0,170'] })), ['off-palette-colour']);
    assert.equal(ok({ blockColours: ['40,40,55'] }).status, 'passed');
  });
  test('a background no part of the page has fails; one the page has does not', () => {
    assert.deepEqual(types(ok({ blockBackgrounds: ['255,230,0'] })), ['off-palette-background']);
    assert.equal(ok({ blockBackgrounds: ['245,247,250', '255,255,255'] }).status, 'passed');
  });
  test('touching the content above fails only where the page\'s own paragraphs have air', () => {
    assert.deepEqual(types(ok({ gapAbove: 0 })), ['butted']);
    assert.equal(ok({ gapAbove: 0, rhythm: 4 }).status, 'passed');
  });
  test('a full-width page band is spaced by its own padding and is as wide as the page: never "butted" or "out of the column"', () => {
    assert.equal(ok({ gapAbove: 0, outside: { left: 300, right: 400 }, fullBleed: true }).status, 'passed');
    assert.deepEqual(types(ok({ gapAbove: 0, outside: { left: 300, right: 400 }, fullBleed: false })).sort(), ['butted', 'out-of-container']);
    assert.deepEqual(types(ok({ fullBleed: true, blockColours: ['255,0,170'] })), ['off-palette-colour']); // everything else still applies to a band
  });
  test('a guessed position (no marker on the page yet) is never called butted: it says nothing about where the block will really sit', () => {
    assert.equal(ok({ gapAbove: 0, injected: 'fallback' }).status, 'passed');
  });
  test('answers running into the next question fail where the page has air, and only warn where it does not', () => {
    const q = S({ weight: 600 });
    const crammed = (rhythm) => judgeStyleFidelity(facts({ ...page, rhythm, blockSizes: [16], blockColours: ['34,34,51'], pairs: [pair(q, S(), 1), pair(q, S(), 2)] }));
    assert.deepEqual(crammed(16).issues.map((i) => i.type), ['crammed']);
    assert.equal(crammed(null).status, 'passed');
    assert.equal(crammed(null).warnings[0].type, 'crammed');
  });
  test('sticking out of its column fails', () => {
    assert.deepEqual(types(ok({ outside: { left: 0, right: 40 } })), ['out-of-container']);
    assert.equal(ok({ outside: { left: 1, right: 22 } }).status, 'passed'); // a card or indent a little off the column is fine
  });
  test('centered text in a left-aligned page fails on alignment (Zunkiree\'s current FAQ template)', () => {
    assert.deepEqual(types(ok({ refAlign: 'left', blockAlign: 'center' })), ['alignment-mismatch']);
    assert.equal(ok({ refAlign: 'center', blockAlign: 'center' }).status, 'passed');
  });
  test('headings may use a display font the page uses somewhere; a font nothing else uses fails (Chayce\'s headings are a design, not a mismatch)', () => {
    assert.equal(ok({ pageFamilies: ['poppins', 'playfair display'], headingFamilies: ['playfair display'] }).status, 'passed');
    assert.deepEqual(types(ok({ pageFamilies: ['poppins'], headingFamilies: ['comic sans ms'] })), ['font-mismatch']);
  });
  test('wider than a phone screen, or text too small to read on one, fails', () => {
    assert.deepEqual(types(ok({ mobile: { blocks: 1, overflowPx: 72, minText: 14 } })), ['mobile-overflow']);
    assert.deepEqual(types(ok({ mobile: { blocks: 1, overflowPx: 0, minText: 9 } })), ['mobile-tiny-text']);
    assert.equal(ok({ mobile: { blocks: 1, overflowPx: 0, minText: 14 } }).status, 'passed');
  });
  test('too little to compare against (a page with almost no text) is never held against the block', () => {
    const r = judgeStyleFidelity(facts({ pageSizes: [16], pageColours: ['0,0,0'], blockSizes: [40], blockColours: ['255,0,0'] }), { kind: 'prose' });
    assert.equal(r.status, 'passed');
  });
});

describe('judgeStyleFidelity — what the browser measured', () => {
  test('nothing inserted means nothing judged (the page had no insertion point)', () => {
    assert.deepEqual(judgeStyleFidelity({ injected: false }), { status: 'skipped', reason: 'no-insertion-point', issues: [], warnings: [] });
  });
  test('questions set apart from answers pass', () => {
    const r = judgeStyleFidelity(facts({ pairs: [pair(S({ weight: 600, size: 18 }), S({ size: 14 })), pair(S({ weight: 600, size: 18 }), S({ size: 14 }))] }));
    assert.equal(r.status, 'passed');
  });
  test('MOBILISE / Superrank: questions identical to answers is a failure', () => {
    const r = judgeStyleFidelity(facts({ pairs: [pair(), pair(), pair()] }));
    assert.equal(r.status, 'failed');
    assert.equal(r.issues[0].type, 'no-hierarchy');
    assert.match(r.issues[0].detail, /All 3 questions look exactly like their answers/);
  });
  test('one differing property is enough to count as set apart (weight, size, colour, italic, case)', () => {
    for (const q of [S({ weight: 700 }), S({ size: 19 }), S({ color: 'rgb(20, 20, 20)' }), S({ italic: 'italic' }), S({ upper: 'uppercase' })]) {
      assert.equal(judgeStyleFidelity(facts({ pairs: [pair(q, S()), pair(q, S())] })).status, 'passed');
    }
  });
  test('a single pair is not enough evidence to judge hierarchy', () => {
    assert.equal(judgeStyleFidelity(facts({ pairs: [pair()] })).status, 'passed');
  });
  test('a different font from the page\'s own text fails, and says which', () => {
    const r = judgeStyleFidelity(facts({ blockFamily: 'times new roman' }), { kind: 'prose' });
    assert.equal(r.status, 'failed');
    assert.equal(r.issues[0].type, 'font-mismatch');
    assert.match(r.issues[0].detail, /"times new roman".*"inter"/);
  });
  test('a page that sets its body text in two families accepts a block in either (Admizz: Rubik 22 paragraphs, Montserrat 13)', () => {
    const f = (block) => judgeStyleFidelity(facts({ refFamily: 'rubik', refFamilies: ['rubik', 'montserrat'], blockFamily: block }), { kind: 'prose' });
    assert.equal(f('montserrat').status, 'passed');
    assert.equal(f('rubik').status, 'passed');
    assert.equal(f('times new roman').status, 'failed');
  });
  test('an unknown reference font is never held against the block', () => {
    assert.equal(judgeStyleFidelity(facts({ refFamily: null, blockFamily: 'x' }), { kind: 'prose' }).status, 'passed');
  });
  test('crammed answers are only a warning where the page gives no rhythm to compare with', () => {
    const q = S({ weight: 600 });
    const r = judgeStyleFidelity(facts({ pairs: [pair(q, S(), 2), pair(q, S(), 0), pair(q, S(), null)] }));
    assert.equal(r.status, 'passed');
    assert.equal(r.warnings[0].type, 'crammed');
  });
  test('prose blocks are never asked for question hierarchy', () => {
    assert.equal(judgeStyleFidelity(facts({ pairs: [pair(), pair()] }), { kind: 'prose' }).status, 'passed');
  });
  test('the markers that are judged', () => {
    assert.deepEqual(Object.keys(STYLE_CHECKED_MARKERS).sort(), ['DIRECTANSWER', 'EXPANDEDCONTENT', 'FAQ', 'INTERNALLINKS', 'QACONTENT']);
    assert.equal(describeStyleIssues([{ detail: 'a.' }, { detail: 'b.' }]), 'a. b.');
  });
});

// Real chromium on fixture pages built like the real failures. Skipped (not failed) where no browser can start.
const PROSE = '<p>' + 'The page\'s own paragraph text, long enough to count as real body copy for the reference measurement. '.repeat(3) + '</p>';
const SITE_CSS = `<style>
  body{font-family:Inter,Arial,sans-serif;font-size:16px;color:#223}
  article p{margin:0 0 16px;line-height:1.6}
  .faq-wrap{margin:32px 0;border-top:1px solid #ccc}
  .faq-q{font-weight:600;font-size:19px;color:#111;margin:20px 0 6px}
  .faq-a{font-size:15px;margin:0 0 18px;color:#445}
  h2{font-size:19px;color:#111;font-weight:600;margin:24px 0 8px}
  .muted{font-size:15px;color:#445;margin:0 0 16px}
  .scroll{overflow-x:auto}
</style>`;
const page = (inner) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${SITE_CSS}</head><body><article>${PROSE}<h2>A section heading</h2>${PROSE}<p class="muted">Muted supporting text, as real pages have.</p>${inner}</article></body></html>`)}`;
const BARE_FAQ = '<dl><dt>What is X?</dt><dd>It is Y, explained in a sentence.</dd><dt>How does X work?</dt><dd>It works like Z, explained in a sentence.</dd><dt>Is X free?</dt><dd>Yes, it is free to use for everyone.</dd></dl>';
const STYLED_FAQ = '<div class="faq-wrap"><h3 class="faq-q">What is X?</h3><p class="faq-a">It is Y, explained in a sentence.</p><h3 class="faq-q">How does X work?</h3><p class="faq-a">It works like Z, explained in a sentence.</p></div>';
const BARE_DETAILS = '<div><details><summary>What is X?</summary><p>It is Y.</p></details><details><summary>How does X work?</summary><p>It works like Z.</p></details></div>';

describe('checkStyleFidelity — a real browser, fixture pages', () => {
  let browser = null;
  before(async () => { try { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); } catch { browser = null; } });
  after(async () => { await browser?.close().catch(() => {}); });
  const run = (pageUrl, marker, html) => checkStyleFidelity({ pageUrl, marker, newContentHtml: html, launchBrowserFn: async () => ({ newContext: (o) => browser.newContext(o), close: async () => {} }) });

  test('a bare <dl> FAQ is refused, first insertion (no marker on the page yet)', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'FAQ', BARE_FAQ);
    assert.equal(r.ok, true);
    assert.equal(r.injected, 'fallback');
    assert.equal(r.passed, false);
    assert.equal(r.issues[0].type, 'no-hierarchy');
  });
  test('bare <details>/<summary> is refused too', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'QACONTENT', BARE_DETAILS);
    assert.equal(r.passed, false);
    assert.equal(r.issues[0].type, 'no-hierarchy');
  });
  test('an FAQ carrying the page\'s own question/answer styling passes', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'FAQ', STYLED_FAQ);
    assert.equal(r.ok, true);
    assert.equal(r.passed, true, JSON.stringify(r.issues));
  });
  test('the page\'s own marker is used when it exists (the bare block is still refused there)', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page('<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->'), 'FAQ', BARE_FAQ);
    assert.equal(r.injected, 'marker');
    assert.equal(r.passed, false);
  });
  test('a block in a different font from the page fails on font', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'EXPANDEDCONTENT', '<div style="font-family: Courier New, monospace"><p>An expanded section written in a font the page never uses, long enough to count.</p></div>');
    assert.equal(r.passed, false);
    assert.equal(r.issues[0].type, 'font-mismatch');
  });
  test('a prose block that inherits the page\'s typography passes', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'EXPANDEDCONTENT', '<section><h2>More detail</h2><p>An expanded section that inherits the page typography, long enough to count as text.</p></section>');
    assert.equal(r.passed, true, JSON.stringify(r.issues));
  });
  test('a hard-coded colour the page never uses fails', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'EXPANDEDCONTENT', '<section><h2>More detail</h2><p style="color:#ff00aa">Text in a colour the page never uses, long enough to count as real text.</p></section>');
    assert.equal(r.passed, false);
    assert.ok(r.issues.some((i) => i.type === 'off-palette-colour'), JSON.stringify(r.issues));
  });
  test('a font size the page never uses fails', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'EXPANDEDCONTENT', '<section><p style="font-size:40px">Text at a size nothing on the page uses, long enough to count as real text.</p></section>');
    assert.equal(r.passed, false);
    assert.ok(r.issues.some((i) => i.type === 'off-scale-size'), JSON.stringify(r.issues));
  });
  test('a background the page never uses fails', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'EXPANDEDCONTENT', '<section style="background:#ffe600"><p>A section on a yellow background nothing else on the page has, long enough to count.</p></section>');
    assert.ok(r.issues.some((i) => i.type === 'off-palette-background'), JSON.stringify(r.issues));
  });
  test('a block wider than its column fails, and one that is too wide for a phone fails on the phone', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'EXPANDEDCONTENT', '<div style="width:1500px"><p>A very wide block that sticks out of the article column, long enough to count as text.</p></div>');
    assert.ok(r.issues.some((i) => i.type === 'out-of-container'), JSON.stringify(r.issues));
    assert.ok(r.issues.some((i) => i.type === 'mobile-overflow'), JSON.stringify(r.issues));
  });
  test('centered answers on a left-aligned page fail on alignment', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'FAQ', '<div style="text-align:center"><h3 class="faq-q">What is X?</h3><p class="faq-a">It is Y, explained in a sentence that is long enough to count as an answer here.</p><h3 class="faq-q">How does X work?</h3><p class="faq-a">It works like Z, explained in a sentence that is long enough to count as an answer too.</p></div>');
    assert.ok(r.issues.some((i) => i.type === 'alignment-mismatch'), JSON.stringify(r.issues));
  });
  test('the FAQ\'s own <script> (structured data) is not a rendered box and never counts as the block sticking out', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(page(''), 'FAQ', STYLED_FAQ + '<script type="application/ld+json">{"@type":"FAQPage"}</script>');
    assert.equal(r.passed, true, JSON.stringify(r.issues));
  });
  test('a page that already overflows a phone screen is not blamed on the block (Superrank: 614px wide on 390px before any block)', async (t) => {
    if (!browser) return t.skip('no browser available');
    const wide = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${SITE_CSS}</head><body><div style="width:700px"><article>${PROSE}<h2>Heading</h2>${PROSE}<p class="muted">Muted text.</p></article></div></body></html>`)}`;
    const r = await run(wide, 'FAQ', STYLED_FAQ);
    assert.ok(!r.issues?.some((i) => i.type === 'mobile-overflow'), JSON.stringify(r.issues));
  });
  test('a closed <details> accordion with the page\'s own styling is not "crammed": hidden answers have no position to measure', async (t) => {
    if (!browser) return t.skip('no browser available');
    const acc = '<div><details><summary class="faq-q">What is X?</summary><p class="faq-a">It is Y, explained in a sentence that is long enough.</p></details><details><summary class="faq-q">How does X work?</summary><p class="faq-a">It works like Z, explained in a sentence that is long enough.</p></details></div>';
    const r = await run(page(''), 'QACONTENT', acc);
    assert.ok(!r.issues?.some((i) => i.type === 'crammed') && !r.warnings?.some((i) => i.type === 'crammed'), JSON.stringify([r.issues, r.warnings]));
    assert.equal(r.passed, true, JSON.stringify(r.issues));
  });
  test('a full-width <section> band on a page with a narrow text column is accepted, but a narrow block that sticks out is still refused', async (t) => {
    if (!browser) return t.skip('no browser available');
    const narrow = (inner) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${SITE_CSS}<style>article{max-width:600px;margin:0 auto}.band{background:#f5f7fa;padding:40px 0}.band h3{font-size:19px;font-weight:600;color:#111}</style></head><body><article>${PROSE}${PROSE}<h2>Heading</h2>${PROSE}<p class="muted">Muted text.</p></article>${inner}</body></html>`)}`;
    const band = '<section class="band"><div style="max-width:600px;margin:0 auto"><h3>What is X?</h3><p class="faq-a">It is Y, explained in a sentence long enough to count as an answer.</p><h3>How does X work?</h3><p class="faq-a">It works like Z, explained in a sentence long enough to count as an answer.</p></div></section>';
    const ok1 = await run(narrow(''), 'FAQ', band);
    assert.ok(!ok1.issues?.some((i) => ['out-of-container', 'butted'].includes(i.type)), JSON.stringify(ok1.issues));
    const bad = await run(narrow(''), 'EXPANDEDCONTENT', '<div style="width:1000px;margin-left:-200px"><p>A plain wide block with no band, sticking out of the text column, long enough to count as text.</p></div>');
    assert.ok(bad.issues?.some((i) => i.type === 'out-of-container'), JSON.stringify(bad.issues));
  });
  test('a wide table inside its own scrolling wrapper is correct responsive design, not an overflow (Zunkiree /blog/how-to-build-rag-pipeline/)', async (t) => {
    if (!browser) return t.skip('no browser available');
    const wide = '<div class="scroll"><table style="min-width:900px"><tr><th>Option</th><th>Latency</th><th>Cost</th></tr><tr><td>One</td><td>Two</td><td>Three</td></tr></table></div>';
    const r = await run(page(''), 'EXPANDEDCONTENT', `<section><h2>Comparison</h2>${wide}</section>`);
    assert.equal(r.passed, true, JSON.stringify(r.issues));
  });
  test('a page with no main text container and no marker is skipped, not failed', async (t) => {
    if (!browser) return t.skip('no browser available');
    const r = await run(`data:text/html,${encodeURIComponent('<html><body><div>tiny</div></body></html>')}`, 'FAQ', BARE_FAQ);
    assert.deepEqual([r.ok, r.skip], [true, true]);
  });
  test('a marker that is not judged (meta-title, schema) is skipped without opening a browser', async () => {
    const r = await checkStyleFidelity({ pageUrl: 'https://x.test', marker: 'SCHEMA', newContentHtml: '<script></script>', launchBrowserFn: async () => { throw new Error('must not launch'); } });
    assert.deepEqual([r.ok, r.skip, r.reason], [true, true, 'marker-not-judged']);
  });
  test('no browser or an unreachable page is "could not run", never a verdict', async () => {
    const r1 = await checkStyleFidelity({ pageUrl: 'https://x.test', marker: 'FAQ', newContentHtml: BARE_FAQ, launchBrowserFn: async () => { throw new Error('no chromium'); } });
    assert.deepEqual([r1.ok, r1.reason], [false, 'browser-unavailable']);
    const fake = { newContext: async () => ({ newPage: async () => ({ goto: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); } }) }), close: async () => {} };
    const r2 = await checkStyleFidelity({ pageUrl: 'https://nope.invalid', marker: 'FAQ', newContentHtml: BARE_FAQ, launchBrowserFn: async () => fake });
    assert.deepEqual([r2.ok, r2.reason], [false, 'unreachable']);
  });
});
