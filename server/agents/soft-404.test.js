import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let fetchStatus;
let fetchError;

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});

const { run } = await import('./soft-404.js');

beforeEach(() => {
  site = { id: 1, website_domain: 'example.com', tech_stack: 'eleventy' };
  fetchStatus = 200;
  fetchError = null;
  global.fetch = async () => {
    if (fetchError) throw fetchError;
    return { status: fetchStatus };
  };
});

describe('soft-404 agent', () => {
  test('insufficient-data when the site has no website_domain', async () => {
    site = { id: 1 };
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('ok, no finding, when the probe correctly returns a real 404', async () => {
    fetchStatus = 404;
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.facts.findings, []);
  });

  test('flags a finding when a guaranteed-nonexistent URL returns 2xx', async () => {
    fetchStatus = 200;
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'ok');
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].id, 'soft-404:site:homepage-fallback');
  });

  test('offers the auto-fix (soft-404-nginx) for a known static-site generator', async () => {
    site.tech_stack = 'eleventy';
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings[0].recommendedAction?.generatorId, 'soft-404-nginx');
  });

  test('reports the finding but withholds the auto-fix for an unknown/unset tech_stack — never assumes static-site', async () => {
    site.tech_stack = null;
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });

  test('an unconfirmed-stack finding still declares reportOnly — never silently dropped by buildRecommendations', async () => {
    site.tech_stack = null;
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings[0].reportOnly.kind, 'soft-404');
  });

  test('a known-static-generator finding (auto-fixable) carries no reportOnly — it\'s draftable, not evidence-only', async () => {
    site.tech_stack = 'eleventy';
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings[0].reportOnly, null);
  });

  test('withholds the auto-fix for a real SPA framework — the same fallback pattern is intentional there', async () => {
    site.tech_stack = 'react-spa';
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });

  test('insufficient-data (never a false finding) when the probe request itself fails', async () => {
    fetchError = new Error('ETIMEDOUT');
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });
});
