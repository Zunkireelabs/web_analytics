import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSeedTermsForSite } from './keyword-demand.js';

test('seed terms come from the verified business profile’s products, never the customers’ industries, and no homepage is fetched', async () => {
  const profile = { fields: { productsServices: { value: [{ name: 'Online booking' }, { name: 'Staff scheduling' }, { name: 'Online booking' }] }, targetCustomerIndustries: { value: ['Spas', 'Salons'] } } };
  const terms = await deriveSeedTermsForSite({ id: 8872, website_domain: 'zennly.io' }, { start: '2026-10-01', end: '2026-11-01' }, { deps: { loadBusinessContext: async () => ({ canonical: true, profile }) } });
  assert.deepEqual(terms, ['Online booking', 'Staff scheduling']);
});

test('a profile that lists no products falls through to the homepage derivation', async () => {
  const profile = { fields: { productsServices: { value: [] } } };
  // no website domain: the homepage path returns no terms without any network access
  const terms = await deriveSeedTermsForSite({ id: 1, website_domain: null }, { start: '2026-10-01', end: '2026-11-01' }, { deps: { loadBusinessContext: async () => ({ canonical: true, profile }) } }).catch(() => []);
  assert.deepEqual(terms, []);
});
