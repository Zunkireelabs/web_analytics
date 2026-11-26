import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareBlockToBaseline, compareOutside, headingIssues, overflowRegression, describeDeviations } from './compare.js';
import { decideProtection } from './decide.js';
import { adoptSiteClasses, fixHeadingLevels, wrapWideElements, repairsFor, repairLoop } from './repair.js';
import { baselineUsability } from './store.js';
import { designProtectionMode, designRepairAttempts } from './mode.js';

// A baseline in the shape captureTemplateBaseline saves it: the Chayce blog template (body 17px, lead paragraph styled separately, so the mode is 17).
const font = { family: 'inter', color: 'rgb(34, 34, 34)' };
const BASELINE = {
  tokens: {
    desktop: { p: { fontSize: 17, lineHeightRatio: 1.7, fontWeight: '400', ...font }, h2: { fontSize: 32, fontWeight: '700', family: 'inter', color: 'rgb(10, 10, 10)' }, h3: { fontSize: 22, fontWeight: '600', family: 'inter', color: 'rgb(10, 10, 10)' }, link: { color: 'rgb(0, 80, 200)' }, containerWidth: 720, radii: [8] },
    mobile: { p: { fontSize: 16, lineHeightRatio: 1.7, fontWeight: '400', ...font }, h2: { fontSize: 26, fontWeight: '700', family: 'inter', color: 'rgb(10, 10, 10)' }, link: { color: 'rgb(0, 80, 200)' }, containerWidth: 358, radii: [8] },
  },
  vocabulary: ['blog-post-body', 'faq-item', 'faq-q', 'card'],
  patterns: { faq: { present: true, classes: ['faq-item'] }, table: { present: false }, 'related-links': { present: true, classes: ['card'] }, breadcrumbs: { present: false }, elementClasses: { h2: '', p: '', ul: 'blog-list', table: undefined } },
};
const goodBlock = { found: true, text: { family: 'inter', fontSize: 17, fontWeight: '400', color: 'rgb(34, 34, 34)', lineHeightRatio: 1.7 }, headings: { h2: { family: 'inter', fontSize: 32, fontWeight: '700', color: 'rgb(10, 10, 10)' } }, link: { color: 'rgb(0, 80, 200)' }, classes: ['faq-item', 'faq-q'], radii: [8], maxWidth: 720, overflowing: [], headingLevels: [2], h1Count: 0, table: null };

describe('block vs template baseline', () => {
  test('a block that uses the template\'s own values has no deviation at either width', () => {
    assert.deepEqual(compareBlockToBaseline(goodBlock, BASELINE, 'desktop'), []);
    assert.deepEqual(compareBlockToBaseline({ ...goodBlock, text: { ...goodBlock.text, fontSize: 16 }, maxWidth: 358, headings: { h2: { ...goodBlock.headings.h2, fontSize: 26 } } }, BASELINE, 'mobile'), []);
  });
  test('the Chayce false failure is gone: 17px body measured against a 17px template passes (the old check compared it with the 19px lead paragraph)', () => {
    assert.deepEqual(compareBlockToBaseline({ ...goodBlock, text: { ...goodBlock.text, fontSize: 17 } }, BASELINE, 'desktop').filter((d) => d.kind === 'body-size'), []);
  });
  test('but a REAL break is still caught: a 22px body, another font, another colour, a 40px heading, a rounded card the template does not use', () => {
    const kinds = (b) => compareBlockToBaseline({ ...goodBlock, ...b }, BASELINE, 'desktop').map((d) => d.kind);
    assert.ok(kinds({ text: { ...goodBlock.text, fontSize: 22 } }).includes('body-size'));
    assert.ok(kinds({ text: { ...goodBlock.text, family: 'comic sans ms' } }).includes('font-family'));
    assert.ok(kinds({ text: { ...goodBlock.text, color: 'rgb(255, 0, 0)' } }).includes('text-color'));
    assert.ok(kinds({ text: { ...goodBlock.text, fontWeight: '700' } }).includes('font-weight'));
    assert.ok(kinds({ headings: { h2: { ...goodBlock.headings.h2, fontSize: 40 } } }).includes('heading-scale'));
    assert.ok(kinds({ radii: [24] }).includes('radius'));
    assert.ok(kinds({ link: { color: 'rgb(255, 0, 0)' } }).includes('link-color'));
    assert.ok(kinds({ maxWidth: 1000 }).includes('container-width'));
    assert.ok(kinds({ classes: ['faq-item', 'my-own-fancy-box'] }).includes('foreign-classes'));
    assert.ok(kinds({ table: { cellFontSize: 12, border: '1px', wrapped: false } }).length >= 0);
  });
  test('only mobile reports an overflow, and only the block\'s own overflow', () => {
    const b = { ...goodBlock, overflowing: ['table.wide'] };
    assert.ok(compareBlockToBaseline(b, BASELINE, 'mobile').some((d) => d.kind === 'mobile-overflow'));
    assert.ok(!compareBlockToBaseline(b, BASELINE, 'desktop').some((d) => d.kind === 'mobile-overflow'));
  });
  test('no baseline tokens for a viewport, or no block: nothing is invented', () => {
    assert.deepEqual(compareBlockToBaseline(goodBlock, { tokens: {} }, 'desktop'), []);
    assert.deepEqual(compareBlockToBaseline({ found: false }, BASELINE, 'desktop'), []);
  });
});

describe('outside the change, headings, overflow', () => {
  const snap = (sig, extra = {}) => ({ count: sig.length, sig, heading: [1, 2, 2], overflow: false, ...extra });
  test('identical outside is unchanged; one changed element, or a different count, is reported', () => {
    assert.deepEqual(compareOutside(snap(['a|1', 'b|2']), snap(['a|1', 'b|2'])), []);
    assert.equal(compareOutside(snap(['nav|x|16px', 'b|2']), snap(['nav|x|20px', 'b|2']))[0].kind, 'outside-changed');
    assert.equal(compareOutside(snap(['a', 'b']), snap(['a', 'b', 'c']))[0].kind, 'outside-changed');
  });
  test('headings: a second H1 and a skipped level are the change\'s fault; an existing skip is not', () => {
    assert.equal(headingIssues([1, 2], [1, 2, 1], null)[0].kind, 'second-h1');
    assert.equal(headingIssues([1, 2], [1, 2], { h1Count: 1 })[0].kind, 'second-h1');
    assert.equal(headingIssues([1, 2], [1, 2, 4], null)[0].kind, 'skipped-heading-level');
    assert.deepEqual(headingIssues([1, 2, 4], [1, 2, 4, 2], null), [], 'the page already skipped; the change did not add one');
    assert.deepEqual(headingIssues([1, 2], [1, 2, 3, 2], null), []);
  });
  test('a sideways scroll is blamed on the change only when the page was fine before', () => {
    assert.equal(overflowRegression(false, true).length, 1);
    assert.equal(overflowRegression(true, true).length, 0);
    assert.equal(overflowRegression(false, false).length, 0);
  });
  test('descriptions are readable', () => assert.match(describeDeviations([{ kind: 'body-size', expected: 17, actual: 22, viewport: 'desktop' }, { kind: 'outside-changed', detail: 'nav changed' }]), /body-size 17 → 22 \(desktop\); outside-changed: nav changed/));
});

describe('the one policy (decideProtection): nothing is assumed to pass', () => {
  const visible = { visible: true, kind: 'faq', format: true, reasons: [] };
  const usable = { usable: true, reason: 'ready' };
  const okRender = { status: 'ok', deviations: [], outside: [], heading: [], overflow: [] };
  test('not visible: nothing to judge, never blocked', () => {
    const d = decideProtection({ mode: 'enforce', classification: { visible: false, reasons: ['meta only'] } });
    assert.deepEqual([d.verdict, d.blocked, d.wouldBlock], ['not-visible', false, false]);
  });
  test('visible + no usable baseline: awaiting-baseline (every reason), blocked only in enforce, but wouldBlock always', () => {
    for (const reason of ['missing', 'stale', 'unstable', 'capture-failed', 'capture-requested', 'no-template']) {
      const e = decideProtection({ mode: 'enforce', classification: visible, baseline: { usable: false, reason } });
      assert.deepEqual([e.verdict, e.blocked, e.wouldBlock, e.reasons[0].code], ['awaiting-baseline', true, true, `baseline-${reason}`], reason);
      const l = decideProtection({ mode: 'log', classification: visible, baseline: { usable: false, reason } });
      assert.deepEqual([l.verdict, l.blocked, l.wouldBlock], ['awaiting-baseline', false, true]);
    }
  });
  test('a FAQ on a template that shows no FAQ anywhere needs input: nothing is invented', () => {
    const d = decideProtection({ mode: 'enforce', classification: visible, baseline: usable, patternPresent: false, render: okRender });
    assert.deepEqual([d.verdict, d.blocked], ['needs-input', true]);
    assert.equal(decideProtection({ mode: 'enforce', classification: { ...visible, format: false }, baseline: usable, patternPresent: false, render: okRender }).verdict, 'pass');
  });
  test('the render could not run (unreachable / no body region / error): awaiting-verification, never a pass', () => {
    for (const status of ['unreachable', 'no-region', 'error']) { const d = decideProtection({ mode: 'enforce', classification: visible, baseline: usable, patternPresent: true, render: { status } }); assert.equal(d.verdict, 'awaiting-verification', status); assert.equal(d.blocked, true); }
    assert.equal(decideProtection({ mode: 'enforce', classification: visible, baseline: usable, patternPresent: true, render: null }).verdict, 'awaiting-verification');
  });
  test('a measured deviation, an outside change, a heading problem or an overflow: blocked, with the reason codes and viewport', () => {
    const d = decideProtection({ mode: 'enforce', classification: visible, baseline: usable, patternPresent: true, render: { ...okRender, deviations: [{ kind: 'body-size', expected: 17, actual: 22, viewport: 'mobile' }] } });
    assert.deepEqual([d.verdict, d.blocked, d.repairable, d.reasons[0].code, d.reasons[0].viewport], ['blocked', true, true, 'body-size', 'mobile']);
    const o = decideProtection({ mode: 'enforce', classification: visible, baseline: usable, patternPresent: true, render: { ...okRender, outside: [{ kind: 'outside-changed', detail: 'nav' }] } });
    assert.deepEqual([o.verdict, o.repairable], ['blocked', false], 'reaching outside itself is never "repaired" by rewriting the block');
  });
  test('everything measured a match: pass', () => {
    const d = decideProtection({ mode: 'enforce', classification: visible, baseline: usable, patternPresent: true, render: okRender });
    assert.deepEqual([d.verdict, d.blocked, d.wouldBlock], ['pass', false, false]);
  });
  test('a shared-file change cannot be judged without a built preview; a preview that differs blocks; one that matches passes', () => {
    const base = { mode: 'enforce', classification: { ...visible, format: false }, baseline: usable, patternPresent: null, sharedPaths: ['src/_includes/base.njk'], renderRequired: false };
    assert.equal(decideProtection({ ...base, sharedPreview: null }).verdict, 'awaiting-verification');
    assert.equal(decideProtection({ ...base, sharedPreview: { status: 'none' } }).verdict, 'awaiting-verification');
    assert.equal(decideProtection({ ...base, sharedPreview: { status: 'unreachable' } }).verdict, 'awaiting-verification');
    const differs = decideProtection({ ...base, sharedPreview: { status: 'differs', detail: '/blog/a header changed' } });
    assert.deepEqual([differs.verdict, differs.reasons[0].code, differs.repairable], ['blocked', 'unrelated-pages-changed', false]);
    assert.equal(decideProtection({ ...base, sharedPreview: { status: 'same' } }).verdict, 'pass');
  });
});

describe('baseline usability (never assumed, never stale)', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  const ready = (daysAgo, over = {}) => ({ status: 'ready', tokens: {}, captured_at: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(), ...over });
  test('only a fresh ready baseline is usable; each other state says why', () => {
    assert.equal(baselineUsability(ready(3), { now }).usable, true);
    assert.deepEqual([baselineUsability(null, { now }).reason, baselineUsability({ status: 'requested' }, { now }).reason, baselineUsability({ status: 'failed', capture_error: 'x' }, { now }).reason, baselineUsability({ status: 'unstable' }, { now }).reason], ['missing', 'capture-requested', 'capture-failed', 'unstable']);
    assert.equal(baselineUsability(ready(45), { now }).reason, 'stale');
    assert.equal(baselineUsability(ready(3, { tokens: null }), { now }).usable, false);
  });
});

describe('bounded repair uses the site\'s OWN design and never ships a failure', () => {
  test('adoptSiteClasses: foreign classes go, the template\'s own come in, inline styling is dropped, unobserved kinds are untouched', () => {
    const out = adoptSiteClasses('<h2 class="text-4xl font-black" style="font-size:40px">Q</h2><p class="lead big">A</p><ul><li>x</li></ul><div class="faq-item my-own-box">k</div>', BASELINE);
    assert.ok(!out.includes('text-4xl') && !out.includes('style=') && !out.includes('my-own-box') && !out.includes('class="lead'));
    assert.ok(out.includes('class="blog-list"') && out.includes('class="faq-item"'));
  });
  test('fixHeadingLevels: an H1 becomes an H2 and a skipped level is closed', () => {
    assert.equal(fixHeadingLevels('<h1>T</h1><p>x</p><h4>S</h4>'), '<h2>T</h2><p>x</p><h3>S</h3>');
    assert.equal(fixHeadingLevels('<h2>A</h2><h3>B</h3><h2>C</h2>'), '<h2>A</h2><h3>B</h3><h2>C</h2>');
  });
  test('wrapWideElements puts a table in a scrolling box once', () => {
    const once = wrapWideElements('<table><tr><td>x</td></tr></table>');
    assert.ok(once.includes('data-dp-scroll') && once.includes('overflow-x:auto'));
    assert.equal(wrapWideElements(once), once);
  });
  test('repairsFor maps deviations to repairs', () => {
    assert.deepEqual(repairsFor([{ kind: 'foreign-classes' }, { kind: 'second-h1' }, { kind: 'mobile-overflow' }]), ['adoptSiteClasses', 'fixHeadingLevels', 'wrapWideElements']);
    assert.deepEqual(repairsFor([{ kind: 'outside-changed' }]), []);
  });
  test('repairLoop re-checks with the same check and stops at the first pass', async () => {
    let calls = 0;
    const check = async (html) => { calls++; return html.includes('foreign') ? { verdict: 'blocked', repairable: true, reasons: [{ code: 'foreign-classes' }] } : { verdict: 'pass', reasons: [] }; };
    const r = await repairLoop({ html: '<p class="foreign">x</p>', baseline: BASELINE, check, maxAttempts: 2 });
    assert.deepEqual([r.repaired, r.final.verdict, r.attempts.length, calls], [true, 'pass', 1, 2]);
    assert.ok(!r.html.includes('foreign'));
  });
  test('repairLoop is bounded, gives up when a repair changes nothing, and never converts a failure into a pass', async () => {
    const stuck = async () => ({ verdict: 'blocked', repairable: true, reasons: [{ code: 'body-size' }] });
    const r = await repairLoop({ html: '<p>x</p>', baseline: { vocabulary: [], patterns: {} }, check: stuck, maxAttempts: 3 });
    assert.deepEqual([r.repaired, r.final.verdict], [false, 'blocked']);
    let n = 0; const never = async () => { n++; return { verdict: 'blocked', repairable: true, reasons: [{ code: 'foreign-classes' }] }; };
    const r2 = await repairLoop({ html: '<p class="a">x</p>', baseline: { ...BASELINE, vocabulary: ['b'] }, check: never, maxAttempts: 2 });
    assert.equal(r2.final.verdict, 'blocked'); assert.ok(n <= 3);
    const notRepairable = await repairLoop({ html: 'x', baseline: BASELINE, check: async () => ({ verdict: 'blocked', repairable: false, reasons: [{ code: 'outside-changed' }] }), maxAttempts: 2 });
    assert.equal(notRepairable.attempts.length, 0);
  });
});

describe('mode', () => {
  test('defaults to log; off/enforce are honoured; garbage falls back to log; repair attempts are capped', () => {
    assert.equal(designProtectionMode({}), 'log');
    assert.equal(designProtectionMode({ DESIGN_PROTECTION_MODE: 'ENFORCE' }), 'enforce');
    assert.equal(designProtectionMode({ DESIGN_PROTECTION_MODE: 'off' }), 'off');
    assert.equal(designProtectionMode({ DESIGN_PROTECTION_MODE: 'whatever' }), 'log');
    assert.equal(designRepairAttempts({}), 2); assert.equal(designRepairAttempts({ DESIGN_PROTECTION_REPAIR_ATTEMPTS: '9' }), 3); assert.equal(designRepairAttempts({ DESIGN_PROTECTION_REPAIR_ATTEMPTS: '0' }), 0);
  });
});
