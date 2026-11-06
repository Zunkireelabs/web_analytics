import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLayoutFingerprint, compareLayouts, captureCoverage, validatePageDesign, checkEditDesignIntegrity,
  attachValidatedContext, validatedContextFor, buildDesignContext, liveDesignValidationEnabled, pageDesignIntegrityMode,
  createLimiter, createFetchCache, captureOnce,
} from './live-design-validation.js';
import { runWithDesignContexts } from './design-context-scope.js';

const O = 'https://x.test';
// A page is <main> with one <section> per class string, content inside; site chrome sits outside <main>.
const page = (blocks, content = '<p>Some text.</p>') =>
  `<html><body><header class="site-hd a b c d"><nav>menu</nav></header><main>${blocks.map((c) => `<section class="${c}"><div>${content}</div></section>`).join('')}</main><footer class="site-ft x"></footer></body></html>`;
const POST = ['post-wrap mx-auto max-w-3xl', 'post-title text-4xl font-bold', 'post-body prose prose-lg', 'author-box flex gap-4', 'related grid grid-cols-3'];
const SERVICE = ['svc-hero bg-navy py-24 text-white', 'svc-grid grid grid-cols-2 gap-8', 'svc-cta bg-gold px-8 py-12'];
const BRAND_NEW = ['zz-a a1 a2 a3 a4', 'zz-b b1 b2 b3 b4', 'zz-c c1 c2 c3 c4'];

const sec = (classes) => ({ role: 'content', classes, textHierarchy: [{ role: 'subheading', classes }] });
const entry = (path, blocks, pageType = 'other') => ({ url: O + path, pageType, sections: blocks.map(sec) });
const profileFor = (extra = {}) => ({
  pages: [entry('/blog/a', POST, 'blog-article'), entry('/services/x', SERVICE, 'service')],
  layoutGroups: { revision: 3, groups: [
    { id: 'g1', size: 3, sample: '/blog/a', members: ['/blog/a', '/blog/b', '/blog/redesigned'] },
    { id: 'g2', size: 2, sample: '/services/x', members: ['/services/x', '/services/y'] },
  ] },
  ...extra,
});
const siteWith = (profile = profileFor()) => ({ id: 1, url_file_map: { siteRoot: { designProfile: profile } } });
const web = (map, log = null) => async (url) => {
  const key = new URL(url).pathname;
  if (log) log.push(key);
  const v = map[key];
  if (v === undefined) throw Object.assign(new Error('HTTP 404'), { httpStatus: 404 });
  if (v instanceof Error) throw v;
  return v;
};
const baseWeb = () => ({
  '/blog/a': page(POST), '/blog/b': page(POST), '/blog/redesigned': page(POST),
  '/services/x': page(SERVICE), '/services/y': page(SERVICE),
});
const fresh = () => createFetchCache(); // a new cache per test: no leakage between cases
const mkCapture = () => { const calls = []; return { calls, fn: async (url) => { calls.push(url); return { url, pageType: 'other', sections: [sec('captured-class-one other-b')] }; } }; };
const visualOk = async () => ({ verdict: 'match', issues: [] });
const V = (site, url, map, extra = {}) => validatePageDesign(site, url, { fetchHtml: web(map), pageCache: fresh(), captureFn: mkCapture().fn, visualCheck: visualOk, ...extra });

describe('fingerprint — layout, not content', () => {
  test('ignores text, content elements, lists and site chrome; is versioned', () => {
    const lean = computeLayoutFingerprint(page(POST, '<p>Short.</p>'));
    const rich = computeLayoutFingerprint(page(POST, '<h2 class="c-h2">x</h2><p class="c-p">A very long paragraph…</p><img class="c-img" src="a.jpg"><ul class="c-ul"><li class="c-li">1</li></ul><table><tr><td class="c-td">z</td></tr></table>'.repeat(6)));
    assert.equal(lean.hash, rich.hash);
    assert.equal(lean.skeletonHash, rich.skeletonHash);
    assert.equal(lean.classes.includes('site-hd'), false);
    assert.equal(lean.version, 2);
  });
});

describe('compareLayouts — similarity + containment + structure, uncertainty preserved', () => {
  const fp = (blocks) => computeLayoutFingerprint(page(blocks));
  test('identical template -> match with all three signals at 1', () => {
    const c = compareLayouts(fp(POST), fp(POST));
    assert.deepEqual([c.verdict, c.similarity, c.containment.min, c.skeleton], ['match', 1, 1, 1]);
  });
  test('a different template -> different', () => assert.equal(compareLayouts(fp(POST), fp(SERVICE)).verdict, 'different'));
  test('the audited false-match shape: same design system, three section types differ on each side -> UNCERTAIN, not match', () => {
    const shared = ['container pg-hero rx-band', 'rx-copy rx-lead rx-photo', 'sa-block stage-practice', 'pkg-faq pkg-faq-band', 'cmp-wrap cmp-head cmp-opt', 'btn-row sticky-cta pg-chips'];
    const a = fp([...shared, 'gd-head gd-sec', 'grey', 'rx-guides']);
    const b = fp([...shared, 'ac-intro ac-intro-copy', 'ac-tiles', 'pkg-close-cta']);
    const c = compareLayouts(a, b);
    assert.equal(c.verdict, 'uncertain');
    assert.ok(c.similarity < 0.8, `similarity ${c.similarity}`);
  });
  test('same classes in a different ARRANGEMENT are not a match (structure signal)', () => {
    const c = compareLayouts(fp(POST), fp([...POST].reverse()));
    assert.equal(c.similarity, 1, 'identical class sets…');
    assert.notEqual(c.verdict, 'match', '…but a reordered page is a different layout');
  });
});

describe('validatePageDesign', () => {
  test('a post on its group template matches; the group sample is the design; NOTHING is proposed or changed', async () => {
    const cap = mkCapture();
    const r = await V(siteWith(), O + '/blog/b', baseWeb(), { captureFn: cap.fn });
    assert.equal(r.status, 'matched');
    assert.equal(r.context.source, 'group-sample');
    assert.equal(r.context.groupId, 'g1');
    assert.equal(r.proposal, null);
    assert.equal(cap.calls.length, 0);
    assert.equal(r.context.fingerprint.version, 2);
    assert.equal(r.context.provisional, false);
  });

  test('content-only change (long post, images, lists, quotes) does not capture, propose or change anything', async () => {
    const cap = mkCapture();
    const w = baseWeb();
    w['/blog/b'] = page(POST, '<h2 class="new-h">x</h2><p>' + 'word '.repeat(2000) + '</p><img class="photo" src="x"><blockquote class="q">y</blockquote><ul><li>1</li></ul>');
    const r = await V(siteWith(), O + '/blog/b', w, { captureFn: cap.fn });
    assert.equal(r.status, 'matched'); assert.equal(r.proposal, null); assert.equal(cap.calls.length, 0);
  });

  test('different service pages of one template match their own group, not the blog group', async () => {
    const r = await V(siteWith(), O + '/services/y', baseWeb());
    assert.equal(r.status, 'matched'); assert.equal(r.context.groupId, 'g2');
  });

  test('a post redesigned onto an EXISTING template uses that group for this edit and PROPOSES the move (never applies it)', async () => {
    const cap = mkCapture();
    const w = baseWeb(); w['/blog/redesigned'] = page(SERVICE);
    const r = await V(siteWith(), O + '/blog/redesigned', w, { captureFn: cap.fn });
    assert.equal(r.status, 'matched-other-group');
    assert.equal(r.context.groupId, 'g2');
    assert.deepEqual({ kind: r.proposal.kind, groupId: r.proposal.groupId }, { kind: 'join', groupId: 'g2' });
    assert.equal(cap.calls.length, 0);
  });

  test('a post redesigned onto a layout nothing else has: this edit uses a fresh capture of THAT page, provisionally; a new group is only PROPOSED', async () => {
    const cap = mkCapture();
    const w = baseWeb(); w['/blog/redesigned'] = page(BRAND_NEW);
    const r = await V(siteWith(), O + '/blog/redesigned', w, { captureFn: cap.fn });
    assert.equal(r.status, 'provisional');
    assert.equal(r.context.provisional, true);
    assert.equal(r.context.source, 'fresh-capture');
    assert.equal(r.proposal.kind, 'new-group');
    assert.deepEqual(cap.calls, [O + '/blog/redesigned']);
  });

  test('a newly added page that fits a template is matched without a capture; one with a new layout is captured before editing', async () => {
    const cap = mkCapture();
    const fit = await V(siteWith(), O + '/blog/new-post', { ...baseWeb(), '/blog/new-post': page(POST) }, { captureFn: cap.fn });
    assert.equal(fit.status, 'matched-other-group'); assert.equal(fit.proposal.kind, 'join'); assert.equal(cap.calls.length, 0);
    const novel = await V(siteWith(), O + '/landing/new', { ...baseWeb(), '/landing/new': page(BRAND_NEW) }, { captureFn: cap.fn });
    assert.equal(novel.status, 'provisional'); assert.equal(novel.proposal.kind, 'new-group'); assert.deepEqual(cap.calls, [O + '/landing/new']);
  });

  test('a stale group sample is NOT trusted and NOT silently replaced: provisional capture + a replace-sample PROPOSAL', async () => {
    const stale = profileFor({ pages: [entry('/blog/a', ['gone-class-1 gone-class-2 gone-class-3'], 'blog-article'), entry('/services/x', SERVICE, 'service')] });
    const r = await V(siteWith(stale), O + '/blog/b', baseWeb());
    assert.equal(r.status, 'provisional');
    assert.equal(r.proposal.kind, 'replace-sample'); assert.equal(r.proposal.groupId, 'g1');
    assert.ok(/out of date/.test(r.reason));
  });

  test('an uncertain comparison stays uncertain: provisional fresh capture, flagged, group map untouched', async () => {
    const partial = ['post-wrap mx-auto max-w-3xl', 'post-title text-4xl font-bold', 'post-body prose prose-lg', 'author-box flex', 'u1 u2 u3'];
    const w = baseWeb(); w['/blog/b'] = page(partial);
    const r = await V(siteWith(), O + '/blog/b', w);
    assert.equal(r.status, 'provisional'); assert.equal(r.uncertain, true);
  });

  test('blocked states carry the right TRANSIENT flag — outages retry, permanent problems wait for a person', async () => {
    const s = siteWith();
    const missing = await V(s, O + '/blog/missing', baseWeb());
    assert.deepEqual([missing.status, missing.reason, missing.transient], ['blocked', 'page-gone', false], 'a real 404 is a (possibly) deleted page, not an outage');

    const down = await V(s, O + '/blog/b', { ...baseWeb(), '/blog/b': new Error('socket hang up') });
    assert.deepEqual([down.reason, down.transient], ['page-unreachable', true], 'a network error is transient');

    const w = baseWeb(); delete w['/blog/a'];
    const noSample = await V(s, O + '/blog/b', w);
    assert.deepEqual([noSample.reason, noSample.transient, noSample.context], ['group-sample-unreachable', true, null]);

    const w2 = baseWeb(); w2['/blog/redesigned'] = page(BRAND_NEW);
    const failing = await V(s, O + '/blog/redesigned', w2, { captureFn: async () => { throw new Error('browser crashed'); } });
    assert.deepEqual([failing.reason, failing.transient, failing.context], ['capture-failed', true, null]);

    const w3 = baseWeb(); w3['/blog/b'] = '<html><body><div id="root"></div></body></html>';
    const empty = await V(s, O + '/blog/b', w3);
    assert.deepEqual([empty.reason, empty.transient], ['page-structure-unreadable', false]);
  });

  test('a hung request is bounded by the overall deadline (transient), not left to hang the draft', async () => {
    const started = Date.now();
    const r = await V(siteWith(), O + '/blog/b', baseWeb(), { fetchHtml: (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))), deadlineMs: 60 });
    assert.equal(r.status, 'blocked'); assert.equal(r.transient, true);
    assert.ok(Date.now() - started < 1500, 'returned promptly');
  });

  test('a site with no layout survey is reported as skipped, never as validated', async () => {
    const r = await V({ id: 1, url_file_map: { siteRoot: { designProfile: { pages: [] } } } }, O + '/blog/b', baseWeb());
    assert.equal(r.status, 'skipped'); assert.equal(r.context, null);
  });
});

describe('bounded work: caching, de-duplication, concurrency (M1)', () => {
  test('concurrent validations of the same page share ONE capture and ONE fetch per URL', async () => {
    const log = []; const cap = mkCapture();
    const w = baseWeb(); w['/blog/redesigned'] = page(BRAND_NEW);
    const cache = fresh();
    const opts = { visualCheck: visualOk, fetchHtml: web(w, log), pageCache: cache, captureFn: async (u) => { await new Promise((r) => setTimeout(r, 20)); return cap.fn(u); } };
    const results = await Promise.all(Array.from({ length: 5 }, () => validatePageDesign(siteWith(), O + '/blog/redesigned', opts)));
    assert.ok(results.every((r) => r.status === 'provisional'));
    assert.equal(cap.calls.length, 1, 'one browser capture for five concurrent drafts');
    assert.equal(log.filter((p) => p === '/blog/redesigned').length, 1, 'the page itself fetched once');
  });

  test('the scan of other groups is parallel and bounded, and a failed fetch is not cached', async () => {
    let active = 0; let peak = 0; let calls = 0;
    const slow = async (url) => { calls++; active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; if (calls === 1) throw new Error('blip'); return page(POST); };
    const cache = fresh();
    await assert.rejects(cache('k', () => slow('x')), /blip/);
    assert.equal(await cache('k', () => slow('x')).then(() => 'recovered'), 'recovered', 'the failure was not cached');
    const groups = Array.from({ length: 20 }, (_, i) => ({ id: `g${i + 10}`, size: 1, sample: `/s${i}`, members: [`/s${i}`] }));
    const profile = profileFor(); profile.layoutGroups.groups.push(...groups);
    const w = baseWeb(); for (let i = 0; i < 20; i++) w[`/s${i}`] = page(BRAND_NEW.map((c) => `${c}-${i}`));
    w['/landing/x'] = page(['q1 q2 q3 q4 q5', 'q6 q7 q8 q9 q0', 'r1 r2 r3 r4 r5']);
    active = 0; peak = 0;
    await validatePageDesign(siteWith(profile), O + '/landing/x', { visualCheck: visualOk, fetchHtml: async (u) => { const p = new URL(u).pathname; active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return w[p]; }, pageCache: fresh(), captureFn: mkCapture().fn, scanConcurrency: 4 });
    assert.ok(peak > 1 && peak <= 5, `parallel but bounded (peak ${peak})`);
  });

  test('createLimiter never runs more than N at once', async () => {
    const limit = createLimiter(2); let active = 0; let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => limit(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; })));
    assert.equal(peak, 2);
  });

  test('captureOnce de-duplicates concurrent loaders and releases the key afterwards', async () => {
    let runs = 0; const loader = async () => { runs++; await new Promise((r) => setTimeout(r, 10)); return 'ok'; };
    await Promise.all([captureOnce('k', loader), captureOnce('k', loader), captureOnce('k', loader)]);
    assert.equal(runs, 1);
    await captureOnce('k', loader);
    assert.equal(runs, 2);
  });
});

describe('design context sharing (C1)', () => {
  const ctx = buildDesignContext({ status: 'matched', source: 'group-sample', pageUrl: O + '/blog/b/', groupId: 'g1', entry: entry('/blog/a', POST), fingerprint: computeLayoutFingerprint(page(POST)), liveHtml: page(POST) });

  test('attach / lookup by page path on a site snapshot', () => {
    const site = attachValidatedContext({ id: 1 }, ctx);
    assert.equal(validatedContextFor(site, O + '/blog/b'), ctx);
    assert.equal(validatedContextFor(site, O + '/other'), null);
  });

  test('code that RE-FETCHED the site (every generator does) still finds the context through the draft scope — and concurrent drafts never see each other\'s', async () => {
    const refetchedSite = { id: 1 }; // what getSiteById returns inside a generator: no attached context
    assert.equal(validatedContextFor(refetchedSite, O + '/blog/b'), null, 'outside any scope there is nothing');
    const other = { ...ctx, pagePath: '/blog/other', groupId: 'gX' };
    const seen = await Promise.all([
      runWithDesignContexts([ctx], async () => { await new Promise((r) => setTimeout(r, 10)); return validatedContextFor(refetchedSite, O + '/blog/b')?.groupId; }),
      runWithDesignContexts([other], async () => { await new Promise((r) => setTimeout(r, 5)); return [validatedContextFor(refetchedSite, O + '/blog/b'), validatedContextFor(refetchedSite, O + '/blog/other')?.groupId]; }),
    ]);
    assert.equal(seen[0], 'g1');
    assert.deepEqual(seen[1], [null, 'gX'], 'the second draft sees only its own page');
  });
});

describe('checkEditDesignIntegrity — the edit may not extend the design', () => {
  const before = '<main><section class="post-wrap prose"><p>old</p></section></main>';
  const ctxV = { vocabulary: ['post-wrap', 'prose', 'author-box'] };
  test('reusing classes the page already has is fine', () => {
    assert.equal(checkEditDesignIntegrity({ before, after: before.replace('</main>', '<aside class="author-box"></aside></main>'), context: ctxV }).ok, true);
  });
  test('a class that exists nowhere is flagged', () => {
    const r = checkEditDesignIntegrity({ before, after: before.replace('</main>', '<div class="totally-new-hero bg-fuchsia-500"></div></main>'), context: ctxV });
    assert.equal(r.ok, false); assert.equal(r.issues[0].type, 'unknown-class');
  });
  test('JSX className is understood', () => {
    assert.equal(checkEditDesignIntegrity({ before, after: before + '<div className="brand-new-class" />' }).issues[0].classes[0], 'brand-new-class');
  });
  test('classes from the captured design vocabulary and verified templates are allowed', () => {
    const profile = { typography: { body: 'text-base leading-7' }, color: {}, spacing: {}, layout: {}, components: {} };
    const tpl = { faq: { wrapper: '<div class="faq-wrap gap-2">{{ROWS}}</div>', row: '<div class="faq-row">{{Q}}</div>' } };
    assert.equal(checkEditDesignIntegrity({ before, after: before + '<div class="text-base faq-wrap faq-row"></div>', profile, componentTemplates: tpl }).ok, true);
  });
  test('inline design styles and new <style>/<script> are flagged; JSON-LD, pre-existing and permitted scripts are not', () => {
    assert.equal(checkEditDesignIntegrity({ before, after: before + '<p style="color:#f0f;margin:40px">x</p>', context: ctxV }).issues[0].type, 'inline-style');
    assert.ok(checkEditDesignIntegrity({ before, after: before + '<script>1</script>', context: ctxV }).issues.some((i) => i.type === 'new-script-tag'));
    assert.equal(checkEditDesignIntegrity({ before, after: before + '<script type="application/ld+json">{}</script>', context: ctxV }).ok, true, 'structured data is data');
    assert.equal(checkEditDesignIntegrity({ before, after: before + '<script async src="g.js"></script>', context: ctxV, allowScripts: true }).ok, true, 'analytics-install may add its tag');
    assert.ok(checkEditDesignIntegrity({ before, after: before + '<style>.a{}</style>', context: ctxV }).issues.some((i) => i.type === 'new-style-tag'));
    const withStyle = before + '<p style="color:red">kept</p>';
    assert.equal(checkEditDesignIntegrity({ before: withStyle, after: withStyle + '<p>more</p>', context: ctxV }).ok, true);
  });
});

describe('capture coverage + switches', () => {
  test('captureCoverage measures how much of a capture still exists live; nothing to check is unverifiable, never current', () => {
    assert.equal(captureCoverage([sec('post-wrap max-w-3xl')], page(POST)).coverage, 1);
    assert.equal(captureCoverage([sec('gone-a gone-b')], page(POST)).coverage, 0);
    assert.equal(captureCoverage([{ role: 'content' }], page(POST)).coverage, null);
  });
  test('flags: on by default; PAGE_DESIGN_INTEGRITY enforce|log|off, anything else is enforce', () => {
    assert.equal(liveDesignValidationEnabled({}), true);
    assert.equal(liveDesignValidationEnabled({ LIVE_DESIGN_VALIDATION: 'false' }), false);
    assert.deepEqual(['', 'log', 'off', 'enforce', 'garbage'].map((v) => pageDesignIntegrityMode({ PAGE_DESIGN_INTEGRITY: v || undefined })), ['enforce', 'log', 'off', 'enforce', 'enforce']);
  });
});

describe('rendered visual check inside validation (C)', () => {
  test('structure matches AND it looks the same at all viewports -> matched, with the visual verdict recorded', async () => {
    const r = await V(siteWith(), O + '/blog/b', baseWeb());
    assert.equal(r.status, 'matched'); assert.equal(r.signals.visual.verdict, 'match');
  });
  test('structure matches but the RENDERED design differs -> not matched: fresh capture of this page, flagged, proposal for review', async () => {
    const regression = async () => ({ verdict: 'regression', issues: [{ viewport: 'mobile', kind: 'spacing', detail: 'top padding 140px vs 48px' }] });
    const r = await V(siteWith(), O + '/blog/b', baseWeb(), { visualCheck: regression });
    assert.equal(r.status, 'provisional'); assert.equal(r.visualMismatch, true);
    assert.match(r.reason, /rendered design differs.*mobile spacing/);
    assert.equal(r.proposal.kind, 'new-group');
  });
  test('a visual check that cannot run or measures nothing BLOCKS (transient) — it never silently passes', async () => {
    const crash = await V(siteWith(), O + '/blog/b', baseWeb(), { visualCheck: async () => { throw new Error('browser crashed'); } });
    assert.deepEqual([crash.status, crash.reason, crash.transient], ['blocked', 'visual-check-failed', true]);
    const empty = await V(siteWith(), O + '/blog/b', baseWeb(), { visualCheck: async () => ({ verdict: 'unmeasurable', issues: [{ kind: 'unmeasurable', detail: 'no sections' }] }) });
    assert.equal(empty.reason, 'visual-check-failed');
  });
  test('a page that IS its group sample is not compared with itself', async () => {
    const r = await V(siteWith(), O + '/blog/a', baseWeb(), { visualCheck: async () => assert.fail('must not render a page against itself') });
    assert.equal(r.status, 'matched');
  });
});

test('REGRESSION: a simple static page with a few classed sections is READABLE; an empty client-rendered shell is not', async () => {
  const { isUnreadableFingerprint } = await import('./live-design-validation.js');
  assert.equal(isUnreadableFingerprint(computeLayoutFingerprint('<main><section class="a"></section><section class="b"></section><section class="c"></section></main>')), false);
  assert.equal(isUnreadableFingerprint(computeLayoutFingerprint('<html><body><div id="root"></div></body></html>')), true);
});
