import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideInlineProseMode, detectInlineProseMode, planInlineProseWrite, articleUrlsFromProfile, projectedH2PxFromProfile, applyInlineProseDetection, isInlineProseAutodetectEnabled } from './inline-prose-detect.js';

const m = (over = {}) => ({ found: true, pluginClass: false, bodyFontSize: 16, h2: { fontSize: 28, marginTop: 32, borderBottom: 0 }, ...over });

describe('decideInlineProseMode', () => {
  test('a typography-plugin ancestor means the layout styles prose', () => {
    assert.equal(decideInlineProseMode([m({ pluginClass: true })]).mode, 'layout');
  });
  test('site 1: projection would emit 30-48px against a live 28px — layout', () => {
    // The one case with confirmed live ground truth (2026-10-02).
    const r = decideInlineProseMode([m()], 48);
    assert.equal(r.mode, 'layout');
    assert.equal(r.evidence.signal, 'projection-larger-than-live');
  });
  test('browser-default headings are unstyled — project', () => {
    const unstyled = m({ h2: { fontSize: 24, marginTop: 19.9, borderBottom: 0 } });
    assert.equal(decideInlineProseMode([unstyled, unstyled], 30).mode, 'project');
  });
  test('styled headings that projection would not change are indeterminate, never guessed', () => {
    assert.equal(decideInlineProseMode([m()], 28).mode, 'unknown');
  });
  test('no measurable article is unknown', () => {
    assert.equal(decideInlineProseMode([]).mode, 'unknown');
    assert.equal(decideInlineProseMode([{ found: false }]).mode, 'unknown');
  });
  test('a single unstyled article among styled ones is not enough to call it project', () => {
    const unstyled = m({ h2: { fontSize: 24, marginTop: 19.9, borderBottom: 0 } });
    assert.notEqual(decideInlineProseMode([unstyled, m()], 28).mode, 'project');
  });
});

describe('detectInlineProseMode', () => {
  const fakeBrowser = (measures, { gotoFails = [] } = {}) => async () => {
    let i = 0;
    return {
      newContext: async () => ({ newPage: async () => ({
        goto: async (url) => { if (gotoFails.includes(url)) throw new Error('timeout'); },
        evaluate: async () => measures[i++],
      }) }),
      close: async () => {},
    };
  };
  test('measures each article and decides', async () => {
    const r = await detectInlineProseMode({ articleUrls: ['a', 'b'], projectedH2Px: 48, launchBrowserFn: fakeBrowser([m(), m()]) });
    assert.equal(r.mode, 'layout');
  });
  test('one unreachable article does not sink the rest', async () => {
    const r = await detectInlineProseMode({ articleUrls: ['a', 'b'], projectedH2Px: 48, launchBrowserFn: fakeBrowser([m()], { gotoFails: ['a'] }) });
    assert.equal(r.mode, 'layout');
  });
  test('no browser is unknown with the reason, not a throw', async () => {
    const r = await detectInlineProseMode({ articleUrls: ['a'], launchBrowserFn: async () => { throw new Error('no chromium'); } });
    assert.equal(r.mode, 'unknown');
    assert.equal(r.evidence.reason, 'browser-unavailable');
  });
  test('no articles never launches a browser', async () => {
    let launched = 0;
    const r = await detectInlineProseMode({ articleUrls: [], launchBrowserFn: async () => { launched++; } });
    assert.equal(launched, 0);
    assert.equal(r.mode, 'unknown');
  });
});

describe('planInlineProseWrite', () => {
  test('writes only a real detection onto an unset value', () => {
    assert.deepEqual(planInlineProseWrite(undefined, { mode: 'layout' }), { write: true, mode: 'layout' });
    assert.equal(planInlineProseWrite(undefined, { mode: 'unknown' }).write, false);
  });
  test('a human-set value is never overwritten; a disagreement is reported', () => {
    const r = planInlineProseWrite('project', { mode: 'layout' });
    assert.equal(r.write, false);
    assert.deepEqual(r.mismatch, { configured: 'project', detected: 'layout' });
  });
  test('agreeing with what is set writes nothing', () => {
    assert.equal(planInlineProseWrite('layout', { mode: 'layout' }).reason, 'already-set');
  });
});

describe('profile helpers', () => {
  test('only captured blog-articles, capped', () => {
    const profile = { pages: [{ url: 'u1', pageType: 'blog-article' }, { url: 'u2', pageType: 'service' }, { url: 'u3', pageType: 'blog-article' }, { url: 'u4', pageType: 'blog-article' }, { url: 'u5', pageType: 'blog-article' }] };
    assert.deepEqual(articleUrlsFromProfile(profile), ['u1', 'u3', 'u4']);
  });
  test('the px projection would emit comes from the profile heading class', () => {
    assert.equal(projectedH2PxFromProfile({ typography: { heading: { item: 'text-3xl md:text-4xl lg:text-5xl' } } }), 48);
  });
});

describe('applyInlineProseDetection', () => {
  const profile = { pages: [{ url: 'https://x.com/blog/a', pageType: 'blog-article' }], typography: { heading: { item: 'text-5xl' } } };
  const quiet = { warn: () => {} };
  const site = (inlineProse) => ({ id: 3, url_file_map: { siteRoot: inlineProse ? { inlineProse } : {} } });

  test('writes a real detection onto an unset site, alongside the profile', async () => {
    const saved = [];
    const r = await applyInlineProseDetection({ site: site(), profile, saveConfig: async (x) => { saved.push(x); }, detect: async () => ({ mode: 'layout', evidence: {} }), log: quiet });
    assert.equal(r.written, true);
    assert.equal(saved[0].urlFileMap.siteRoot.inlineProse, 'layout');
    assert.equal(saved[0].urlFileMap.siteRoot.designProfile, profile);
  });
  test('hands the detector the human-written articles and the px projection would emit', async () => {
    let seen;
    await applyInlineProseDetection({ site: site(), profile, saveConfig: async () => {}, detect: async (a) => { seen = a; return { mode: 'unknown' }; }, log: quiet });
    assert.deepEqual(seen, { articleUrls: ['https://x.com/blog/a'], projectedH2Px: 48 });
  });
  test('a human-set value is left alone and the disagreement is logged', async () => {
    const warned = [];
    const r = await applyInlineProseDetection({ site: site('project'), profile, saveConfig: async () => { throw new Error('must not write'); }, detect: async () => ({ mode: 'layout' }), log: { warn: (m) => warned.push(m) } });
    assert.equal(r.written, false);
    assert.match(warned[0], /configured "project" but the detector says "layout"/);
  });
  test('unknown writes nothing', async () => {
    const r = await applyInlineProseDetection({ site: site(), profile, saveConfig: async () => { throw new Error('no'); }, detect: async () => ({ mode: 'unknown' }), log: quiet });
    assert.equal(r.written, false);
  });
  test('never throws — the profile is already saved and is the valuable result', async () => {
    const r = await applyInlineProseDetection({ site: site(), profile, saveConfig: async () => {}, detect: async () => { throw new Error('chromium crashed'); }, log: quiet });
    assert.deepEqual([r.written, r.reason], [false, 'error']);
  });
  test('off unless INLINE_PROSE_AUTODETECT=true', () => {
    assert.equal(isInlineProseAutodetectEnabled({}), false);
    assert.equal(isInlineProseAutodetectEnabled({ INLINE_PROSE_AUTODETECT: 'true' }), true);
  });
});
