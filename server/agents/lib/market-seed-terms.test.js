import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarketServiceTerms } from './market-seed-terms.js';

// The rule being protected: paid market research is only ever seeded from terms the business itself has stated, and a
// site that has described nothing returns nothing rather than a guessed industry.

function deps({ capabilities = [], rows = {} } = {}) {
  return {
    getProductCapabilities: async () => capabilities,
    query: async (sql) => {
      if (/site_profiles/.test(sql)) return { rows: rows.profile || [] };
      if (/site_understanding/.test(sql)) return { rows: rows.understanding || [] };
      return { rows: [] };
    },
  };
}

describe('resolveMarketServiceTerms', () => {
  test('verified capabilities win and are reported as high confidence', async () => {
    const out = await resolveMarketServiceTerms(1, {
      deps: deps({
        capabilities: [{ name: 'Teeth Whitening' }, { name: 'Dental Implants' }],
        rows: { profile: [{ main_topics_json: ['ignored'] }] },
      }),
    });
    assert.deepEqual(out.terms, ['teeth whitening', 'dental implants']);
    assert.equal(out.source, 'verified-capabilities');
    assert.equal(out.confidence, 'high');
  });

  test('falls back to profile topics when nothing is verified', async () => {
    const out = await resolveMarketServiceTerms(1, { deps: deps({ rows: { profile: [{ main_topics_json: ['seo audit', 'rank tracking'] }] } }) });
    assert.deepEqual(out.terms, ['seo audit', 'rank tracking']);
    assert.equal(out.source, 'site-profile-topics');
  });

  test('profile topics are accepted as objects or as a JSON string', async () => {
    const asObjects = await resolveMarketServiceTerms(1, { deps: deps({ rows: { profile: [{ main_topics_json: [{ topic: 'seo audit' }, { name: 'geo' }] }] } }) });
    assert.deepEqual(asObjects.terms, ['seo audit', 'geo']);
    const asString = await resolveMarketServiceTerms(1, { deps: deps({ rows: { profile: [{ main_topics_json: '["seo audit"]' }] } }) });
    assert.deepEqual(asString.terms, ['seo audit']);
  });

  test('falls back to confirmed site understanding last', async () => {
    const out = await resolveMarketServiceTerms(1, { deps: deps({ rows: { understanding: [{ subject: 'Emergency Dental Care' }] } }) });
    assert.deepEqual(out.terms, ['emergency dental care']);
    assert.equal(out.source, 'site-understanding');
  });

  test('a site that has described nothing returns no terms and no invented source', async () => {
    const out = await resolveMarketServiceTerms(1, { deps: deps() });
    assert.deepEqual(out.terms, []);
    assert.equal(out.source, null);
  });

  test('junk, duplicates and sentences are dropped', async () => {
    const out = await resolveMarketServiceTerms(1, {
      deps: deps({ capabilities: [{ name: '  SEO  Audit ' }, { name: 'seo audit' }, { name: 'ab' }, { name: 'x'.repeat(80) }, { name: null }] }),
    });
    assert.deepEqual(out.terms, ['seo audit']);
  });

  test('a database failure degrades to "nothing known", never to a guess', async () => {
    const out = await resolveMarketServiceTerms(1, {
      deps: {
        getProductCapabilities: async () => { throw new Error('db down'); },
        query: async () => { throw new Error('db down'); },
      },
    });
    assert.deepEqual(out.terms, []);
    assert.equal(out.source, null);
  });

  test('the term list is capped', async () => {
    const out = await resolveMarketServiceTerms(1, {
      deps: deps({ capabilities: Array.from({ length: 30 }, (_, i) => ({ name: `service ${i}` })) }),
    });
    assert.equal(out.terms.length, 12);
  });
});

import { normalizeProfile as _np, applyReview as _ar } from '../../lib/business-profile.js';

describe('resolveMarketServiceTerms with a canonical business profile', () => {
  const ev = [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }];
  const F = (value) => ({ value, status: 'detected', confidence: 'high', evidence: ev });
  const profile = () => _np({ fields: { ownIndustry: F({ label: 'Software (SaaS)' }), productsServices: F([{ name: 'Online booking' }, { name: 'Staff scheduling' }]), targetCustomerIndustries: F(['Spas', 'Salons']) } });
  const noCaps = async () => [];
  const noDb = async () => ({ rows: [{ main_topics_json: JSON.stringify(['gym', 'fitness']) }] });

  test('the products the company sells beat the stale topic list, and customer industries never become service terms', async () => {
    const out = await resolveMarketServiceTerms(1, { deps: { getProductCapabilities: noCaps, query: noDb, getBusinessProfile: async () => ({ profile: profile() }) } });
    assert.deepEqual(out.terms, ['online booking', 'staff scheduling']);
    assert.equal(out.source, 'business-profile');
    assert.equal(out.confidence, 'medium');
    assert.ok(!out.terms.includes('spas') && !out.terms.includes('gym'));
  });

  test('a person-confirmed product list is high confidence', async () => {
    const confirmed = _ar(profile(), [{ field: 'productsServices', accept: true }], { userId: 1 }).profile;
    const out = await resolveMarketServiceTerms(1, { deps: { getProductCapabilities: noCaps, query: noDb, getBusinessProfile: async () => ({ profile: confirmed }) } });
    assert.equal(out.confidence, 'high');
  });

  test('verified capabilities still come first, and with no profile the old ladder is unchanged', async () => {
    const caps = await resolveMarketServiceTerms(1, { deps: { getProductCapabilities: async () => [{ name: 'Verified thing' }], query: noDb, getBusinessProfile: async () => ({ profile: profile() }) } });
    assert.equal(caps.source, 'verified-capabilities');
    const legacy = await resolveMarketServiceTerms(1, { deps: { getProductCapabilities: noCaps, query: noDb, getBusinessProfile: async () => null } });
    assert.equal(legacy.source, 'site-profile-topics');
  });
});
