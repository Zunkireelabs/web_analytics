import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMobileUsabilityAudit, configured } from './pagespeed.js';

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.PAGESPEED_API_KEY;

describe('fetchMobileUsabilityAudit', () => {
  beforeEach(() => { process.env.PAGESPEED_API_KEY = 'test-key'; });
  afterEach(() => { global.fetch = ORIGINAL_FETCH; process.env.PAGESPEED_API_KEY = ORIGINAL_KEY; });

  test('refuses when no key is configured, same as fetchCoreWebVitals', async () => {
    delete process.env.PAGESPEED_API_KEY;
    await assert.rejects(() => fetchMobileUsabilityAudit('https://example.com'), /PAGESPEED_API_KEY is not set/);
    assert.equal(configured(), false);
  });

  test('extracts real tap-target and font-size audit data from a lab run', async () => {
    global.fetch = async (url) => {
      assert.match(url, /category=seo/);
      assert.match(url, /strategy=mobile/);
      return {
        ok: true,
        json: async () => ({
          lighthouseResult: {
            audits: {
              'tap-targets': { score: 0.5, details: { items: [{ tappable: 'button.cta', size: '20x18' }] } },
              'font-size': { score: 0.9, displayValue: '92% legible text' },
            },
          },
        }),
      };
    };
    const result = await fetchMobileUsabilityAudit('https://example.com');
    assert.equal(result.ok, true);
    assert.equal(result.dataSource, 'lab');
    assert.equal(result.tapTargets.score, 0.5);
    assert.equal(result.tapTargets.failingElements.length, 1);
    assert.equal(result.fontSize.score, 0.9);
    assert.equal(result.fontSize.summary, '92% legible text');
  });

  test('a null score (audit not applicable) is passed through as null, never coerced', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ lighthouseResult: { audits: { 'tap-targets': { score: null }, 'font-size': { score: null } } } }),
    });
    const result = await fetchMobileUsabilityAudit('https://example.com');
    assert.equal(result.tapTargets.score, null);
    assert.equal(result.fontSize.score, null);
  });

  test('an HTTP failure is reported honestly, not thrown', async () => {
    global.fetch = async () => ({ ok: false, status: 500 });
    const result = await fetchMobileUsabilityAudit('https://example.com');
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 500/);
  });

  test('no lighthouseResult at all reports honestly', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    const result = await fetchMobileUsabilityAudit('https://example.com');
    assert.equal(result.ok, false);
    assert.match(result.error, /no lab data/);
  });
});
