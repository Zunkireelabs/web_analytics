import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { protectVisibleChange, describeProtection } from './protect.js';

const PROFILE = { layoutGroups: { groups: [{ id: 'g1', sample: '/blog/a', members: ['/blog/a', '/blog/b', '/blog/c'] }] } };
const site = (id = 8864, profile = PROFILE) => ({ id, url_file_map: { siteRoot: { designProfile: profile } } });
const BASELINE_ROW = {
  status: 'ready', captured_at: new Date().toISOString(), sample_urls: ['/blog/a', '/blog/c'], confidence: 'agreeing-samples',
  tokens: { desktop: { p: { fontSize: 17, lineHeightRatio: 1.7, fontWeight: '400', family: 'inter', color: 'rgb(0, 0, 0)' }, containerWidth: 720, radii: [] }, mobile: { p: { fontSize: 16, lineHeightRatio: 1.7, fontWeight: '400', family: 'inter', color: 'rgb(0, 0, 0)' }, containerWidth: 358, radii: [] } },
  vocabulary: ['faq-item'], patterns: { faq: { present: true }, table: { present: false }, 'related-links': { present: false }, breadcrumbs: { present: false }, elementClasses: { p: '' } },
};
const fakeStore = (row = BASELINE_ROW) => {
  const calls = { requested: [], decisions: [], got: [] };
  return { calls, getBaseline: async (siteId, key) => { calls.got.push([siteId, key]); return row; }, requestBaseline: async (siteId, key) => { calls.requested.push([siteId, key]); return {}; }, recordProtectionDecision: async (siteId, d) => { calls.decisions.push({ siteId, ...d }); return true; } };
};
const OK = { status: 'ok', deviations: [], outside: [], heading: [], overflow: [], evidence: { viewports: {} } };
const change = (over = {}) => ({ generatorId: 'faq', actionType: 'faq', draftId: 11, recommendationId: 5, findingId: 'f', pageUrl: 'https://x.test/blog/b', html: '<div class="faq-item">q</div>', marker: 'FAQ', ...over });
const run = (c, { mode = 'enforce', store = fakeStore(), render = OK, quarantined = [], s = site(), extra = {} } = {}) =>
  protectVisibleChange({ site: s, change: c, mode, deps: { store, renderCheck: typeof render === 'function' ? render : async () => render, quarantine: async (...a) => quarantined.push(a), ...extra } });

describe('a NEW page (no live URL yet) is judged in a real page of the same template', () => {
  const NEW = { generatorId: 'blog-outline', actionType: 'blog-outline', pageUrl: '/blog/b', newPage: true, origin: 'https://x.test', html: '<h2>Hi</h2><p>Body</p>', marker: null };
  test('it renders as the whole body region of a reference page of its own template, on the project\'s own origin', async () => {
    let seen = null; const store = fakeStore();
    const r = await run(change(NEW), { store, render: async (a) => { seen = a; return OK; } });
    assert.equal(r.verdict, 'pass');
    assert.deepEqual([seen.mode, seen.pageUrl.startsWith('https://x.test/blog/'), seen.pageUrl.endsWith('/blog/b')], ['region', true, false], 'a reference page, not the page being created');
  });
  test('markup that cannot be rendered from source (template syntax, JSX) is awaiting-verification: needs a built preview, never a pass', async () => {
    let rendered = false;
    const r = await run(change({ ...NEW, html: '', unrenderable: 'template-syntax' }), { render: async () => { rendered = true; return OK; } });
    assert.deepEqual([r.verdict, r.pending, r.ok], ['awaiting-verification', true, false]); assert.equal(rendered, false);
    assert.match(JSON.stringify(r.reasons), /template-syntax/);
    const log = await run(change({ ...NEW, html: '', unrenderable: 'jsx-not-renderable' }), { mode: 'log' });
    assert.deepEqual([log.ok, log.wouldBlock], [true, true]);
  });
  test('a page type with no captured template yet waits for a baseline (the capture is requested)', async () => {
    const store = fakeStore(null);
    const r = await run(change({ ...NEW, pageUrl: '/guides/new', pageType: 'guide' }), { store });
    assert.deepEqual([r.verdict, r.reason], ['awaiting-baseline', 'baseline-missing']);
    assert.deepEqual(store.calls.requested, [[8864, 'type:guide:guides']], 'the capture is requested; with no live pages it will record that as its failure, making the gap visible');
  });
});

describe('protectVisibleChange', () => {
  test('mode off runs nothing', async () => {
    const store = fakeStore(); const r = await run(change(), { mode: 'off', store });
    assert.deepEqual([r.ok, r.verdict], [true, 'skipped']); assert.equal(store.calls.decisions.length, 0);
  });
  test('a change that is not visible passes, and the decision (with why) is still recorded', async () => {
    const store = fakeStore(); const r = await run(change({ generatorId: 'meta-description', actionType: 'meta-description' }), { store });
    assert.deepEqual([r.ok, r.verdict], [true, 'not-visible']);
    assert.equal(store.calls.decisions[0].visible, false); assert.equal(store.calls.decisions[0].verdict, 'not-visible');
  });
  test('a visible change that matches passes at both widths and records its evidence', async () => {
    const store = fakeStore(); const r = await run(change(), { store });
    assert.deepEqual([r.ok, r.verdict, r.blocked, r.pending], [true, 'pass', false, false]);
    assert.equal(store.calls.decisions[0].templateKey, 'group:g1'); assert.equal(store.calls.decisions[0].visible, true);
  });
  test('NO baseline: capture is requested and the change WAITS (enforce) — it is never passed', async () => {
    const store = fakeStore(null); let rendered = false;
    const r = await run(change(), { store, render: async () => { rendered = true; return OK; } });
    assert.deepEqual([r.verdict, r.ok, r.pending, r.reason], ['awaiting-baseline', false, true, 'baseline-missing']);
    assert.deepEqual(store.calls.requested, [[8864, 'group:g1']]);
    assert.equal(rendered, false, 'it does not render against a reference it does not have');
    assert.match(r.error, /being captured/);
  });
  test('log mode with no baseline: still requests the capture, records would-block, lets the existing gates decide', async () => {
    const store = fakeStore(null); const r = await run(change(), { mode: 'log', store });
    assert.deepEqual([r.ok, r.verdict, r.wouldBlock, r.blocked], [true, 'awaiting-baseline', true, false]);
    assert.equal(store.calls.requested.length, 1); assert.equal(store.calls.decisions[0].wouldBlock, true);
  });
  test('a stale or unstable baseline is not usable either, and is re-requested', async () => {
    const old = { ...BASELINE_ROW, captured_at: new Date(Date.now() - 90 * 86_400_000).toISOString() };
    const s1 = fakeStore(old); const r1 = await run(change(), { store: s1 });
    assert.deepEqual([r1.verdict, r1.reason, s1.calls.requested.length], ['awaiting-baseline', 'baseline-stale', 1]);
    const s2 = fakeStore({ ...BASELINE_ROW, status: 'unstable', disagreements: [{ field: 'p.fontSize' }] }); const r2 = await run(change(), { store: s2 });
    assert.deepEqual([r2.reason, s2.calls.requested.length], ['baseline-unstable', 1]);
  });
  test('a page that matches no captured template has no baseline to assume', async () => {
    const store = fakeStore(); const r = await run(change({ pageUrl: 'https://x.test/mystery/page' }), { store });
    assert.deepEqual([r.verdict, r.reason], ['awaiting-baseline', 'baseline-no-template']); assert.equal(store.calls.got.length, 0);
  });
  test('a FAQ on a template with no FAQ to copy needs input; the check does not render it', async () => {
    const store = fakeStore({ ...BASELINE_ROW, patterns: { ...BASELINE_ROW.patterns, faq: { present: false } } });
    const r = await run(change(), { store });
    assert.deepEqual([r.verdict, r.reason, r.ok], ['needs-input', 'no-existing-pattern', false]);
  });
  test('a measured design break is blocked in enforce, only recorded in log, and the item is quarantined with its content kept (not abandoned)', async () => {
    const bad = { ...OK, deviations: [{ kind: 'outside-changed', detail: 'nav changed', viewport: 'desktop' }] };
    const q = []; const enforce = await run(change(), { render: bad, quarantined: q });
    assert.deepEqual([enforce.ok, enforce.verdict, enforce.blocked], [false, 'blocked', true]);
    assert.equal(q.length, 1);
    const [siteId, item] = q[0];
    assert.equal(siteId, 8864); assert.equal(item.outcome, 'failed'); assert.equal(item.failureClass, 'design-protection:blocked'); assert.equal(item.draftId, 11); assert.equal(item.recommendationId, 5);
    assert.match(item.reason, /does not match the site's design/);
    const q2 = []; const log = await run(change(), { mode: 'log', render: bad, quarantined: q2 });
    assert.deepEqual([log.ok, log.wouldBlock, log.blocked], [true, true, false]); assert.equal(q2.length, 0, 'log mode never quarantines');
  });
  test('waiting verdicts are quarantined as retryable; needs-input as needs_human', async () => {
    const q = []; await run(change(), { store: fakeStore(null), quarantined: q });
    assert.equal(q[0][1].retryPolicy, 'retry'); assert.equal(q[0][1].failureClass, 'design-protection:awaiting-baseline');
    const q2 = []; await run(change(), { store: fakeStore({ ...BASELINE_ROW, patterns: { faq: { present: false } } }), quarantined: q2 });
    assert.equal(q2[0][1].retryPolicy, 'needs_human');
  });
  test('the render could not run: awaiting-verification, not a pass', async () => {
    const r = await run(change(), { render: { status: 'unreachable', error: 'timeout' } });
    assert.deepEqual([r.verdict, r.pending, r.ok], ['awaiting-verification', true, false]);
  });
  test('ENFORCE repairs a repairable failure with the site\'s own classes and ships the REPAIRED html, re-checked by the same check', async () => {
    let seen = [];
    const render = async ({ html }) => { seen.push(html); return html.includes('my-own') ? { ...OK, deviations: [{ kind: 'foreign-classes', expected: 'x', actual: 'my-own', viewport: 'desktop' }] } : OK; };
    const r = await run(change({ html: '<div class="faq-item my-own">q</div>' }), { render });
    assert.deepEqual([r.ok, r.verdict, r.repaired], [true, 'pass', true]);
    assert.ok(!r.html.includes('my-own') && r.html.includes('faq-item')); assert.equal(seen.length, 2);
    assert.equal(r.evidence.repair.repaired, true);
  });
  test('LOG mode never alters what ships: the original html comes back even when it was repairable', async () => {
    const render = async () => ({ ...OK, deviations: [{ kind: 'foreign-classes', expected: 'x', actual: 'my-own', viewport: 'desktop' }] });
    const r = await run(change({ html: '<div class="faq-item my-own">q</div>' }), { mode: 'log', render });
    assert.equal(r.html, '<div class="faq-item my-own">q</div>'); assert.equal(r.wouldBlock, true); assert.equal(r.repaired, false);
  });
  test('a failure repair cannot fix is quarantined after the bounded attempts, never shipped', async () => {
    const q = []; const render = async () => ({ ...OK, deviations: [{ kind: 'body-size', expected: 17, actual: 30, viewport: 'desktop' }] });
    const r = await run(change(), { render, quarantined: q });
    assert.deepEqual([r.ok, r.verdict, r.blocked], [false, 'blocked', true]); assert.equal(q.length, 1);
  });
  test('shared-file-only change: waits without a built preview; passes when other pages are unchanged', async () => {
    const files = [{ path: 'src/_includes/base.njk', before: '<a>', after: '<b>' }];
    const c = change({ generatorId: 'refresh-content', actionType: 'refresh-content', html: null, files, marker: null });
    const r1 = await run(c, { extra: { checkUnrelated: async () => ({ status: 'none' }) } });
    assert.deepEqual([r1.verdict, r1.reason], ['awaiting-verification', 'shared-file-needs-build-preview']);
    const r2 = await run(c, { extra: { checkUnrelated: async () => ({ status: 'same' }) } });
    assert.equal(r2.verdict, 'pass');
    const r3 = await run(c, { extra: { checkUnrelated: async () => ({ status: 'differs', detail: '/blog/a header' }) } });
    assert.deepEqual([r3.verdict, r3.reason], ['blocked', 'unrelated-pages-changed']);
  });
  test('per-tenant: baseline lookup and requests use ONLY this project\'s id; another project\'s profile never supplies the template', async () => {
    const store = fakeStore(null);
    await run(change(), { store, s: site(8872, { layoutGroups: { groups: [{ id: 'z9', sample: '/blog/a', members: ['/blog/a', '/blog/b'] }] } }) });
    assert.deepEqual(store.calls.requested, [[8872, 'group:z9']]);
    assert.ok(store.calls.decisions.every((d) => d.siteId === 8872));
  });
  test('a decision that cannot be recorded never fails the change', async () => {
    const store = { ...fakeStore(), recordProtectionDecision: async () => false };
    assert.equal((await run(change(), { store })).verdict, 'pass');
  });
  test('describeProtection is empty for pass / not-visible', () => { assert.equal(describeProtection({ verdict: 'pass' }), ''); assert.equal(describeProtection({ verdict: 'not-visible' }), ''); });
});
