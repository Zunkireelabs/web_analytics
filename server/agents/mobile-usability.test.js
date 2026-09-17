import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let audits; // page -> pagespeed audit result
let pagespeedIsConfigured;

const realRead = await import(resolve('../store/read.js'));
mock.module(resolve('../store/read.js'), {
  namedExports: {
    ...realRead,
    getSearchPerformanceForPages: async (_siteId, _start, _end, pages) =>
      pages.map((p) => ({ dim_value: p, impressions: 100 })),
  },
});
mock.module(resolve('../llm.js'), { namedExports: { callLLM: async () => 'narrative' } });
const realPagespeed = await import(resolve('../ingest/pagespeed.js'));
mock.module(resolve('../ingest/pagespeed.js'), {
  namedExports: {
    ...realPagespeed,
    configured: () => pagespeedIsConfigured,
    fetchMobileUsabilityAudit: async (page) => audits[page] ?? { ok: false, error: 'no fixture' },
  },
});

const { run, meta } = await import(resolve('./mobile-usability.js'));

const CLEAN_ANALYSIS = { hasViewportMeta: true, viewportHasDeviceWidth: true, viewportBlocksZoom: false, viewportContent: 'width=device-width, initial-scale=1' };
const pageCache = async (page) => ({ ok: true, analysis: { ...CLEAN_ANALYSIS } });

beforeEach(() => {
  audits = {};
  pagespeedIsConfigured = false;
});

describe('mobile-usability — real Lighthouse tap-target/font-size audits', () => {
  test('dataSources reports not-connected when PAGESPEED_API_KEY is unset', () => {
    pagespeedIsConfigured = false;
    assert.equal(meta.dataSources[0].status, 'not-connected');
  });

  test('never calls PSI, and produces no tap-target/font-size findings, when unconfigured', async () => {
    pagespeedIsConfigured = false;
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages: ['https://example.com/a'] } });
    assert.equal(result.facts.pagesWithSmallTapTargets, 0);
    assert.equal(result.facts.pagesWithIllegibleFontSize, 0);
    assert.ok(!result.facts.findings.some((f) => f.id.includes('tap-targets') || f.id.includes('font-size')));
  });

  test('a real failing tap-target score produces a real, detection-only finding', async () => {
    pagespeedIsConfigured = true;
    audits['https://example.com/a'] = {
      ok: true, dataSource: 'lab',
      tapTargets: { score: 0.4, failingElements: [{ tappable: 'a.nav-link', size: '18x16' }] },
      fontSize: { score: 1, summary: '100% legible text', failingElements: [] },
    };
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages: ['https://example.com/a'] } });
    assert.equal(result.facts.pagesWithSmallTapTargets, 1);
    assert.equal(result.facts.pagesWithIllegibleFontSize, 0);
    const finding = result.facts.findings.find((f) => f.id === 'mobile-usability:small-tap-targets');
    assert.ok(finding);
    assert.equal(finding.recommendedAction, null, 'a shared-template style issue must not offer a blind auto-fix');
    assert.match(finding.whyItMatters, /1 of 1 checked pages/);
    // Not silently dropped (the pre-2026-09-03 bug font-consistency.js's own
    // header comment describes) — a real, ambiguous-cause reason instead.
    assert.equal(finding.reportOnly.kind, 'tap-target-too-small');
    assert.equal(finding.reportOnly.page, 'https://example.com/a');
    assert.match(finding.reportOnly.whyBlocked, /doesn't say which CSS property/);
  });

  test('a real failing font-size score with no per-element inline override stays reportOnly, never a blind auto-fix', async () => {
    pagespeedIsConfigured = true;
    audits['https://example.com/a'] = {
      ok: true, dataSource: 'lab',
      tapTargets: { score: 1, failingElements: [] },
      fontSize: { score: 0.5, summary: '52% legible text', failingElements: [{ node: { snippet: '<p class="body-sm">too small</p>' } }] },
    };
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages: ['https://example.com/a'] } });
    assert.equal(result.facts.pagesWithIllegibleFontSize, 1);
    const finding = result.facts.findings.find((f) => f.id === 'mobile-usability:illegible-font-size');
    assert.ok(finding);
    assert.equal(finding.evidence.samples[0].summary, '52% legible text');
    assert.equal(finding.recommendedAction, null, 'a shared CSS class must not get a blind auto-fix');
    assert.equal(finding.reportOnly.kind, 'font-size-too-small');
    assert.equal(finding.reportOnly.page, 'https://example.com/a');
  });

  test('a real failing font-size score caused by one element\'s own inline font-size override reuses font-consistency\'s safe fix', async () => {
    pagespeedIsConfigured = true;
    audits['https://example.com/a'] = {
      ok: true, dataSource: 'lab',
      tapTargets: { score: 1, failingElements: [] },
      fontSize: {
        score: 0.5,
        summary: '52% legible text',
        failingElements: [
          { node: { snippet: '<p class="body-sm">no override</p>' } },
          { node: { snippet: '<span style="font-size: 9px;">too small</span>' } },
        ],
      },
    };
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages: ['https://example.com/a'] } });
    const finding = result.facts.findings.find((f) => f.id === 'mobile-usability:illegible-font-size');
    assert.ok(finding);
    assert.equal(finding.reportOnly, null, 'a safely fixable case must not also be reportOnly');
    assert.ok(finding.recommendedAction);
    assert.equal(finding.recommendedAction.generatorId, 'content-integrity-repair');
    assert.equal(finding.recommendedAction.params.fixType, 'font-size-override');
    assert.equal(finding.recommendedAction.params.page, 'https://example.com/a');
    assert.equal(finding.recommendedAction.params.outerHtml, '<span style="font-size: 9px;">too small</span>');
  });

  test('a null score (audit not applicable to this page) is never treated as a failure', async () => {
    pagespeedIsConfigured = true;
    audits['https://example.com/a'] = {
      ok: true, dataSource: 'lab',
      tapTargets: { score: null, failingElements: [] },
      fontSize: { score: null, summary: null },
    };
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages: ['https://example.com/a'] } });
    assert.equal(result.facts.pagesWithSmallTapTargets, 0);
    assert.equal(result.facts.pagesWithIllegibleFontSize, 0);
  });

  test('a PSI failure for one page never blocks the viewport checks that still succeeded', async () => {
    pagespeedIsConfigured = true;
    audits['https://example.com/a'] = { ok: false, error: 'timeout' };
    const result = await run({ siteId: 1, start: '2026-08-01', end: '2026-08-31', pageCache, params: { pages: ['https://example.com/a'] } });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.pagesWithSmallTapTargets, 0);
  });
});
