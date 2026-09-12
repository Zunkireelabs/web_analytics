import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDesignAnalysisHandler } from './live-analysis-handler.js';

const FAKE_CAPTURE = { homepageUrl: 'https://x.com/', pages: [{ url: 'https://x.com/', pageType: 'homepage', title: 'X', blocks: [] }] };
const FAKE_PROFILE = {
  version: 2,
  typography: { body: 'text-base', heading: { item: 'text-2xl font-bold' } },
  layout: { container: 'max-w-7xl mx-auto' },
};

describe('createLiveDesignAnalysisHandler', () => {
  test('design-profile mode returns { designProfile }, sourced from capture -> segment -> extract, when the site has no stored profile yet', async () => {
    let capturedUrl = null;
    let extractCalledWith = null;
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async (url) => { capturedUrl = url; return FAKE_CAPTURE; },
      extractProfileFn: async (segmented, opts) => { extractCalledWith = { segmented, opts }; return FAKE_PROFILE; },
      getSiteByIdFn: async () => ({ id: 42, url_file_map: {} }),
    });

    const outcome = await handler({ id: 1, site_id: 42, params: { mode: 'design-profile', pageUrl: 'https://x.com/' } });

    assert.equal(capturedUrl, 'https://x.com/');
    assert.equal(outcome.designProfile, FAKE_PROFILE);
    assert.equal(outcome.skippedProfileDerivation, undefined);
    assert.equal(extractCalledWith.opts.siteId, 42);
    assert.equal(extractCalledWith.segmented[0].url, 'https://x.com/');
  });

  test('design-profile mode skips LLM re-derivation when the fresh capture shows no drift from the stored profile', async () => {
    let extractCalled = false;
    const STORED_PROFILE = {
      version: 2,
      typography: { body: 'text-base', heading: { item: 'text-2xl font-bold' } },
      responsive: { breakpoints: ['md:'] },
      components: {},
    };
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => ({
        pages: [{ url: 'https://x.com/', pageType: 'homepage', title: 'X', blocks: [
          { order: 0, tag: 'div', landmark: null, classes: 'flex md:flex', top: 0, height: 200, width: 1440, viewportWidth: 1440 },
        ] }],
      }),
      extractProfileFn: async () => { extractCalled = true; return FAKE_PROFILE; },
      getSiteByIdFn: async (siteId) => ({ id: siteId, url_file_map: { siteRoot: { designProfile: STORED_PROFILE } } }),
    });

    const outcome = await handler({ id: 7, site_id: 42, params: { mode: 'design-profile', pageUrl: 'https://x.com/' } });

    assert.equal(extractCalled, false, 'no drift found — the LLM call must be skipped entirely');
    assert.equal(outcome.designProfile, STORED_PROFILE);
    assert.equal(outcome.skippedProfileDerivation, true);
  });

  test('design-profile mode runs the full LLM re-derivation when the fresh capture shows real drift from the stored profile', async () => {
    let extractCalled = false;
    const STORED_PROFILE = {
      version: 2,
      typography: { body: 'text-base', heading: { item: 'text-2xl font-bold' } },
      responsive: { breakpoints: ['md:'] },
      components: { table: { wrapper: 'table-auto border-collapse' } },
    };
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => ({
        pages: [{
          url: 'https://x.com/', pageType: 'homepage', title: 'X',
          blocks: [
            {
              order: 0, landmark: null, classes: 'flex md:flex', top: 0, height: 200, width: 1440, viewportWidth: 1440,
              tableLike: true, tableClasses: { wrapper: 'totally-different-table-style' },
            },
          ],
        }],
      }),
      extractProfileFn: async () => { extractCalled = true; return FAKE_PROFILE; },
      getSiteByIdFn: async (siteId) => ({ id: siteId, url_file_map: { siteRoot: { designProfile: STORED_PROFILE } } }),
    });

    const outcome = await handler({ id: 8, site_id: 42, params: { mode: 'design-profile', pageUrl: 'https://x.com/' } });

    assert.equal(extractCalled, true, 'real drift found — the LLM re-derivation must run');
    assert.equal(outcome.designProfile, FAKE_PROFILE);
    assert.equal(outcome.skippedProfileDerivation, undefined);
  });

  test('component-templates mode projects only the requested action types from the derived profile', async () => {
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => FAKE_CAPTURE,
      extractProfileFn: async () => FAKE_PROFILE,
    });
    const outcome = await handler({
      id: 2, site_id: 42,
      params: { mode: 'component-templates', componentKeys: ['faq', '__design-profile__'], pageUrl: 'https://x.com/' },
    });
    assert.ok(outcome.componentTemplates.faq);
    assert.equal(outcome.componentTemplates['content-wrapper'], undefined, 'only requested action types are projected');
  });

  test('consistency-scan mode compares the fresh capture against the site\'s STORED profile, never re-derives a new one', async () => {
    let extractCalled = false;
    let getSiteByIdCalledWith = null;
    const STORED_PROFILE = {
      version: 2,
      typography: { body: 'text-base', heading: { item: 'text-2xl font-bold' } },
      responsive: { breakpoints: ['md:'] },
      components: {},
    };
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => ({
        pages: [{ url: 'https://x.com/', pageType: 'homepage', title: 'X', blocks: [
          { order: 0, tag: 'div', landmark: null, classes: 'flex', top: 0, height: 200, width: 1440, viewportWidth: 1440 },
        ] }],
      }),
      extractProfileFn: async () => { extractCalled = true; return FAKE_PROFILE; },
      getSiteByIdFn: async (siteId) => { getSiteByIdCalledWith = siteId; return { id: siteId, url_file_map: { siteRoot: { designProfile: STORED_PROFILE } } }; },
    });

    const outcome = await handler({ id: 5, site_id: 42, params: { mode: 'consistency-scan', pageUrl: 'https://x.com/' } });

    assert.equal(getSiteByIdCalledWith, 42);
    assert.equal(extractCalled, false, 'must never re-derive a new profile — this mode only compares against the stored one');
    assert.equal(outcome.pagesScanned, 1);
    assert.ok(Array.isArray(outcome.consistencyFindings));
  });

  test('consistency-scan mode refuses (input_validation) when the site has no stored profile yet', async () => {
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => FAKE_CAPTURE,
      getSiteByIdFn: async () => ({ id: 42, url_file_map: {} }),
    });
    await assert.rejects(
      () => handler({ id: 6, site_id: 42, params: { mode: 'consistency-scan', pageUrl: 'https://x.com/' } }),
      (err) => { assert.equal(err.stage, 'input_validation'); return true; },
    );
  });

  test('no pageUrl throws an input_validation-staged error, never silently no-ops', async () => {
    const handler = createLiveDesignAnalysisHandler();
    await assert.rejects(
      () => handler({ id: 3, site_id: 42, params: {} }),
      (err) => { assert.equal(err.stage, 'input_validation'); return true; },
    );
  });

  test('a capture failure is tagged with stage live_capture, not a generic error', async () => {
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); },
    });
    await assert.rejects(
      () => handler({ id: 4, site_id: 42, params: { mode: 'design-profile', pageUrl: 'https://x.com/' } }),
      (err) => { assert.equal(err.stage, 'live_capture'); return true; },
    );
  });

  test('zero pages captured is a live_capture failure, not a silent empty profile', async () => {
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => ({ homepageUrl: 'https://x.com/', pages: [] }),
    });
    await assert.rejects(
      () => handler({ id: 5, site_id: 42, params: { mode: 'design-profile', pageUrl: 'https://x.com/' } }),
      (err) => { assert.equal(err.stage, 'live_capture'); return true; },
    );
  });

  test('an extraction failure is tagged result_validation', async () => {
    const handler = createLiveDesignAnalysisHandler({
      captureSiteFn: async () => FAKE_CAPTURE,
      extractProfileFn: async () => { throw new Error('model did not return valid JSON after 2 attempts'); },
      getSiteByIdFn: async () => ({ id: 42, url_file_map: {} }),
    });
    await assert.rejects(
      () => handler({ id: 6, site_id: 42, params: { mode: 'design-profile', pageUrl: 'https://x.com/' } }),
      (err) => { assert.equal(err.stage, 'result_validation'); return true; },
    );
  });
});
