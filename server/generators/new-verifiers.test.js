import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubOpenAI } from '../test-support/stub-openai.js';

const resolve = (p) => new URL(p, import.meta.url).href;
stubOpenAI(mock);

let analysis = {}; let analyzeOk = true; let robots = { ok: false };
const real = await import('../agents/lib/page-content.js');
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: {
    ...real,
    analyzePageUrl: async () => (analyzeOk ? { ok: true, analysis } : { ok: false, error: 'down' }),
    fetchTextIfExists: async () => robots,
  },
});
mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => null, getSearchPerformanceRange: async () => [] } });

const faq = await import('./faq.js');
const breadcrumbs = await import('./breadcrumbs.js');
const robotsBootstrap = await import('./robots-bootstrap.js');
const internalLinks = await import('./internal-links.js');
const page = 'https://example.com/p';

describe('faq.verifyCurrentState', () => {
  test('schema AND visible FAQ present -> already_resolved', async () => {
    analyzeOk = true; analysis = { hasFaqSchema: true, hasVisibleFaqContent: true };
    assert.equal((await faq.verifyCurrentState({ params: { page } })).decision, 'already_resolved');
  });
  test('schema without a visible FAQ is its own defect: still_valid', async () => {
    analysis = { hasFaqSchema: true, hasVisibleFaqContent: false };
    const r = await faq.verifyCurrentState({ params: { page } });
    assert.equal(r.decision, 'still_valid'); assert.equal(r.reason, 'faq-schema-without-visible-faq');
  });
  test('no FAQ at all: still_valid; unreachable page: never closes', async () => {
    analysis = {};
    assert.equal((await faq.verifyCurrentState({ params: { page } })).decision, 'still_valid');
    analyzeOk = false;
    assert.equal((await faq.verifyCurrentState({ params: { page } })).reason, 'unreachable');
  });
});

describe('breadcrumbs.verifyCurrentState', () => {
  test('BreadcrumbList on the page -> already_resolved', async () => {
    analyzeOk = true; analysis = { schemaTypes: ['WebSite', 'BreadcrumbList'], isRootPage: false };
    assert.equal((await breadcrumbs.verifyCurrentState({ params: { page } })).decision, 'already_resolved');
  });
  test('absent on an inner page -> still_valid; the homepage needs no trail', async () => {
    analysis = { schemaTypes: ['WebSite'], isRootPage: false };
    assert.equal((await breadcrumbs.verifyCurrentState({ params: { page } })).decision, 'still_valid');
    analysis = { schemaTypes: [], isRootPage: true };
    assert.equal((await breadcrumbs.verifyCurrentState({ params: { page } })).decision, 'already_resolved');
  });
});

describe('robots-bootstrap.verifyCurrentState', () => {
  const site = { website_domain: 'example.com' };
  test('a real robots.txt with a User-agent group -> already_resolved (never overwrite it)', async () => {
    robots = { ok: true, text: 'User-agent: *\nAllow: /\n' };
    assert.equal((await robotsBootstrap.verifyCurrentState({}, { site })).decision, 'already_resolved');
  });
  test('missing or non-robots content -> still_valid', async () => {
    robots = { ok: false };
    assert.equal((await robotsBootstrap.verifyCurrentState({}, { site })).decision, 'still_valid');
    robots = { ok: true, text: '<html>not found</html>' };
    assert.equal((await robotsBootstrap.verifyCurrentState({}, { site })).decision, 'still_valid');
  });
});

describe('internal-links.verifyCurrentState', () => {
  const rec = { params: { page }, finding_ids: ['technical-seo:no-outgoing-links:https://example.com/p'] };
  test('dead-end premise and the page now has outgoing links -> already_resolved', async () => {
    analyzeOk = true; analysis = { internalLinks: ['https://example.com/a', 'https://example.com/b'] };
    assert.equal((await internalLinks.verifyCurrentState(rec)).decision, 'already_resolved');
  });
  test('only links to itself or fragments do not count', async () => {
    analysis = { internalLinks: ['https://example.com/p', '#top'] };
    assert.equal((await internalLinks.verifyCurrentState(rec)).decision, 'still_valid');
  });
  test('other premises (below-average count, mustLinkTo) are never re-judged here', async () => {
    analysis = { internalLinks: ['https://example.com/a'] };
    assert.equal((await internalLinks.verifyCurrentState({ params: { page }, finding_ids: ['internal-linking:dead-end:x'] })).reason, 'premise-not-rechecked');
    assert.equal((await internalLinks.verifyCurrentState({ params: { page, mustLinkTo: 'https://example.com/z' }, finding_ids: ['technical-seo:no-outgoing-links:x'] })).reason, 'premise-not-rechecked');
  });
});
