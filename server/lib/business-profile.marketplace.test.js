import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile, describeCompany, projectForAgent, applyReview, marketplaceLine, LISTING_SOURCES } from './business-profile.js';
import { GOAL_TYPES } from '../store/site-goals.js';

const withMarketplace = (value) => normalizeProfile({
  fields: {
    ownIndustry: { value: { label: 'Online marketplace' }, status: 'confirmed', confidence: 'high', evidence: [] },
    businessModel: { value: { model: 'marketplace' }, status: 'confirmed', confidence: 'high', evidence: [] },
    marketplace: { value, status: 'confirmed', confidence: 'high', evidence: [] },
  },
});

describe('marketplace profile field', () => {
  test('keeps both sides, listing types, categories, source and monetisation', () => {
    const p = withMarketplace({
      supply: 'independent salon owners', demand: 'clients booking treatments',
      listingTypes: ['salon profiles', 'treatment menus'], categories: ['Hair', 'Spa'],
      listingSource: 'user-generated', monetisation: 'commission per booking',
    });
    assert.equal(p.fields.marketplace.value.supply, 'independent salon owners');
    assert.deepEqual(p.fields.marketplace.value.categories, ['Hair', 'Spa']);
    assert.equal(p.fields.marketplace.value.listingSource, 'user-generated');
  });

  test('an unknown listingSource is dropped and an empty marketplace becomes null', () => {
    assert.equal(withMarketplace({ supply: 'a', listingSource: 'scraped' }).fields.marketplace.value.listingSource, null);
    assert.equal(normalizeProfile({ fields: { marketplace: { value: { listingTypes: [], categories: [] }, status: 'detected', confidence: 'low', evidence: [] } } }).fields.marketplace.value, null);
    assert.equal(normalizeProfile({ fields: { marketplace: { value: 'a marketplace', status: 'detected', confidence: 'low', evidence: [] } } }).fields.marketplace.value, null);
  });

  test('describeCompany tells agents it is two-sided and never to edit user-generated listings', () => {
    const text = describeCompany(withMarketplace({ supply: 'sellers', demand: 'buyers', listingSource: 'user-generated' }));
    assert.match(text, /Two-sided marketplace: supply side is sellers; demand side is buyers/);
    assert.match(text, /never write or edit individual listings/);
  });

  test('a site with no marketplace detail gets no marketplace sentence', () => {
    assert.equal(marketplaceLine(null), '');
    assert.doesNotMatch(describeCompany(normalizeProfile({ fields: { ownIndustry: { value: { label: 'Software (SaaS)' }, status: 'confirmed', confidence: 'high', evidence: [] } } })), /marketplace/i);
  });

  test('content, keyword, seo, competitor and growth agents receive it; a person can confirm it', () => {
    const p = withMarketplace({ supply: 's', demand: 'd' });
    for (const a of ['content', 'keyword', 'seo', 'competitor', 'growth', 'analytics']) assert.ok(projectForAgent(p, a).marketplace, a);
    const { profile, applied } = applyReview(p, [{ field: 'marketplace', accept: true, value: { supply: 'hosts', demand: 'guests' } }]);
    assert.equal(profile.fields.marketplace.status, 'confirmed');
    assert.deepEqual(applied, [{ field: 'marketplace', action: 'edited' }]);
  });

  test('listing sources are the documented four', () => {
    assert.deepEqual([...LISTING_SOURCES], ['user-generated', 'curated', 'imported', 'mixed']);
  });
});

describe('marketplace goal types', () => {
  test('grow_supply, grow_demand and grow_listings are valid and the earlier ones remain', () => {
    for (const t of ['grow_supply', 'grow_demand', 'grow_listings', 'generate_leads', 'grow_signups', 'custom']) assert.ok(GOAL_TYPES.includes(t), t);
  });
});

describe('content focus for a marketplace', () => {
  test('writes for both sides, names the categories, and forbids inventing listings', async () => {
    const { contentFocusLine } = await import('./business-profile.js');
    const line = contentFocusLine(withMarketplace({ supply: 'salon owners', demand: 'clients', categories: ['Hair', 'Spa'], listingSource: 'user-generated' }));
    assert.match(line, /salon owners \(who list\) and clients \(who buy or book\)/);
    assert.match(line, /categories: Hair, Spa/);
    assert.match(line, /Never write about, name or invent individual listings/);
  });
  test('a non-marketplace profile keeps the original line', async () => {
    const { contentFocusLine } = await import('./business-profile.js');
    const p = normalizeProfile({ fields: { targetCustomers: { value: [{ segment: 'Spa owners' }], status: 'confirmed', confidence: 'high', evidence: [] } } });
    assert.match(contentFocusLine(p), /^Write for Spa owners/);
  });
});
