import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIndustry, classifyIndustryFromText, CLASSIFY_SYSTEM } from './industry-capture.js';
import { FEED_CATALOG_KEYS } from '../agents/lib/trend-feeds.js';

describe('resolveIndustry', () => {
  test('nothing known at all is reported as nothing, never guessed', () => {
    assert.deepEqual(resolveIndustry(), { industry: null, source: null, confidence: null, mappable: false });
    assert.deepEqual(resolveIndustry({ explicit: '   ' }).industry, null);
  });

  test('a staff-typed value wins over every inference and is high confidence', () => {
    const out = resolveIndustry({ explicit: 'education', growthIndustries: ['technology'], classified: 'wellness' });
    assert.equal(out.industry, 'education');
    assert.equal(out.source, 'human');
    assert.equal(out.confidence, 'high');
  });

  test('the growth config supplies the industry for a product tenant with no Search Console', () => {
    // The whole reason this module exists: with no GSC the Python collector
    // never runs, so without this the industry stays NULL forever.
    const out = resolveIndustry({ growthIndustries: ['healthcare', 'technology'] });
    assert.equal(out.industry, 'healthcare');
    assert.equal(out.source, 'growth-config');
    assert.equal(out.confidence, 'medium');
  });

  test('an LLM classification is the last resort and is marked low confidence', () => {
    const out = resolveIndustry({ classified: 'technology' });
    assert.equal(out.source, 'llm-classified');
    assert.equal(out.confidence, 'low');
  });

  test('a catalog synonym counts as mappable even though it is not one of the keys', () => {
    // feedsForTenant matches on predicates, not on the key strings, so the
    // mappability check has to agree with the real selection logic.
    const out = resolveIndustry({ explicit: 'SaaS' });
    assert.equal(out.mappable, true);
    assert.equal(out.source, 'human');
  });

  test('an industry the feed catalog cannot match is recorded, but as unmapped', () => {
    // This is the silent failure: stored unmappable, it looks exactly as
    // healthy in the database as a working value, while feedsForTenant
    // returns zero feeds and trend radar reports "too few headlines".
    const out = resolveIndustry({ explicit: 'artisanal coffee roasting subscriptions' });

    assert.equal(out.industry, 'artisanal coffee roasting subscriptions');
    assert.equal(out.source, 'unmapped');
    assert.equal(out.confidence, 'low');
    assert.equal(out.mappable, false);
    assert.equal(out.originalSource, 'human');
  });

  test('a single non-array growth industry is accepted', () => {
    assert.equal(resolveIndustry({ growthIndustries: 'wellness' }).industry, 'wellness');
  });
});

describe('classifyIndustryFromText', () => {
  test('the prompt offers only labels the feed catalog can act on', () => {
    for (const key of FEED_CATALOG_KEYS) assert.ok(CLASSIFY_SYSTEM.includes(key), `${key} must be offered`);
    assert.match(CLASSIFY_SYSTEM, /answer "none"/);
  });

  test('a valid catalog key is returned', async () => {
    const out = await classifyIndustryFromText('We sell student admissions software to colleges.', {
      callJson: async () => ({ industry: 'education', reasoning: 'admissions software for colleges' }),
    });
    assert.equal(out, 'education');
  });

  test('"none" is a real answer, not a failure to retry', async () => {
    const out = await classifyIndustryFromText('We broker refrigerated freight.', {
      callJson: async () => ({ industry: 'none', reasoning: 'no listed industry fits' }),
    });
    assert.equal(out, null);
  });

  test('a plausible near-miss the catalog has no key for is dropped, never mapped to the nearest key', async () => {
    // "ed-tech" is obviously education to a human. Accepting it would mean
    // accepting whatever else a model invents, and a wrong label feeds this
    // tenant another industry's news as if it were its own.
    const out = await classifyIndustryFromText('x', { callJson: async () => ({ industry: 'ed-tech' }) });
    assert.equal(out, null);
  });

  test('a model failure returns null rather than throwing into the onboarding path', async () => {
    const out = await classifyIndustryFromText('x', { callJson: async () => { throw new Error('rate limited'); } });
    assert.equal(out, null);
  });

  test('no text, or no model available, costs nothing and returns null', async () => {
    let called = false;
    assert.equal(await classifyIndustryFromText('', { callJson: async () => { called = true; return {}; } }), null);
    assert.equal(await classifyIndustryFromText('real text'), null);
    assert.equal(called, false);
  });
});
