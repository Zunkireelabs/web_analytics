import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeTenantForRelevance } from './analyst-seo-mapping.js';
import { normalizeProfile, applyReview, contentFocusLine } from '../../lib/business-profile.js';

const ev = [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }];
const F = (value) => ({ value, status: 'detected', confidence: 'high', evidence: ev });
const zennly = () => normalizeProfile({ fields: {
  ownIndustry: F({ label: 'Software (SaaS)' }), productsServices: F([{ name: 'Online booking' }]),
  targetCustomerIndustries: F(['Spas', 'Salons']), targetCustomers: F([{ segment: 'Spa and salon owners' }]),
  customerProblems: F(['Double-bookings']),
} });

// No verified capabilities exist in these tests (the store call fails softly without a database), so the tiers below the capabilities
// are what is being tested.
describe('describeTenantForRelevance with a canonical business profile', () => {
  test('the profile is used, with the company’s own industry kept apart from its customers’, and the legacy lines are not', async () => {
    const r = await describeTenantForRelevance(1, { loadContext: async () => ({
      businessProfile: { version: 2, profile: zennly(), pending: [] },
      siteProfile: { industry: 'wellness', industry_source: 'detected' }, seoPolicy: null, growthConfig: null, productKnowledge: [], industries: ['wellness'], goals: [],
    }) });
    assert.equal(r.source, 'business-profile');
    assert.equal(r.confidence, 'medium'); // detected, not yet confirmed by a person
    assert.match(r.text, /own industry: Software \(SaaS\)/);
    assert.match(r.text, /NOT its own\): Spas, Salons/);
    assert.doesNotMatch(r.text, /Industry: wellness/);
  });

  test('once a person confirms the profile the confidence is high', async () => {
    const confirmed = applyReview(zennly(), ['ownIndustry', 'productsServices', 'targetCustomers'].map((field) => ({ field, accept: true })), { userId: 1 }).profile;
    const r = await describeTenantForRelevance(1, { loadContext: async () => ({ businessProfile: { version: 3, profile: confirmed, pending: [] }, productKnowledge: [], goals: [] }) });
    assert.equal(r.confidence, 'high');
  });

  test('without a profile the legacy tiers behave exactly as before', async () => {
    const r = await describeTenantForRelevance(1, { loadContext: async () => ({ businessProfile: null, productKnowledge: [], industries: ['education'], markets: null, icpSignals: null, goals: [] }) });
    assert.equal(r.source, 'tenant-profile');
    assert.equal(r.confidence, 'low');
    assert.match(r.text, /Industry: education/);
  });
});

describe('contentFocusLine', () => {
  test('points content at the company’s buyers, offering and their problems, and warns against drifting into customers’ industries', () => {
    const line = contentFocusLine(zennly());
    assert.match(line, /Write for Spa and salon owners/);
    assert.match(line, /connected to Online booking/);
    assert.match(line, /problems they face \(Double-bookings\)/);
    assert.match(line, /Do not suggest general topics about the customers' own industries/);
    assert.doesNotMatch(line, /CRM|booking\/automation/);
  });
  test('an empty profile gives no line, so a prompt is left exactly as it was', () => {
    assert.equal(contentFocusLine(normalizeProfile({})), '');
  });
});
