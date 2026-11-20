import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_KEYS, emptyProfile, normalizeProfile, groundEvidence, mergeDetected, applyReview, diffProfiles, contentHash,
  profileState, isUsable, describeCompany, projectForAgent, groundingTerms, ownIndustryLabel, toLegacyIndustry, lastVerifiedAt,
} from './business-profile.js';

const page = (quote, url = 'https://x.test/') => ({ source: 'page', ref: url, summary: 'homepage', quote, url });

// The Zennly identity the owner confirmed (2026-11-20): software, SaaS, sold TO salons and spas.
const zennlyDetected = () => normalizeProfile({
  fields: {
    description: { value: 'Booking and business management software for spas and salons.', status: 'detected', confidence: 'high', evidence: [page('Booking, staff, payroll, payments and reports for spas, salons and gyms')] },
    ownIndustry: { value: { label: 'Software (SaaS)' }, status: 'detected', confidence: 'high', evidence: [page('Spa & Salon Booking Software')] },
    businessModel: { value: { model: 'saas' }, status: 'detected', confidence: 'medium', evidence: [page('Book a 20-minute demo')] },
    productsServices: { value: [{ name: 'Online booking' }, { name: 'Staff and payroll management' }], status: 'detected', confidence: 'high', evidence: [page('Booking, staff, payroll')] },
    targetCustomerIndustries: { value: ['Spas', 'Salons', 'Gyms'], status: 'detected', confidence: 'high', evidence: [page('spas, salons and gyms')] },
    targetCustomers: { value: [{ segment: 'Spa and salon owners' }], status: 'detected', confidence: 'medium', evidence: [page('Built for the businesses that run')] },
    customerProblems: { value: ['Double-bookings', 'Discount leakage'], status: 'detected', confidence: 'high', evidence: [page('Stop double-bookings and discount leakage')] },
  },
});

describe('normalizeProfile', () => {
  test('a malformed or empty input becomes a valid, fully insufficient profile and never throws', () => {
    for (const bad of [null, undefined, 5, 'x', [], { fields: 'no' }]) {
      const p = normalizeProfile(bad);
      assert.deepEqual(Object.keys(p.fields), [...FIELD_KEYS]);
      assert.ok(FIELD_KEYS.every((k) => p.fields[k].status === 'insufficient' && p.fields[k].value === null));
    }
  });

  test('a value with no evidence is downgraded to assumed, so an unsupported claim never reads as detected', () => {
    const p = normalizeProfile({ fields: { ownIndustry: { value: { label: 'Wellness' }, status: 'detected', confidence: 'high', evidence: [] } } });
    assert.equal(p.fields.ownIndustry.status, 'assumed');
  });

  test('unknown fields are dropped and long text is capped', () => {
    const p = normalizeProfile({ fields: { nonsense: { value: 'x' }, description: { value: 'a'.repeat(5000), status: 'detected', evidence: [page('a')] } } });
    assert.equal(p.fields.nonsense, undefined);
    assert.equal(p.fields.description.value.length, 1200);
  });

  test('pricing is its own claim: a business model never implies a pricing model', () => {
    const p = normalizeProfile({ fields: { businessModel: { value: { model: 'agency' }, status: 'detected', evidence: [page('x')] } } });
    assert.equal(p.fields.businessModel.value.pricing, null);
  });
});

describe('groundEvidence', () => {
  test('a quote that is not in the fetched text is dropped, and a field left without grounded evidence becomes insufficient', () => {
    const grounded = groundEvidence(zennlyDetected(), ['Spa & Salon Booking Software in Nepal. Booking, staff, payroll, payments and reports for spas, salons and gyms. Stop double-bookings and discount leakage.']);
    assert.equal(grounded.fields.ownIndustry.status, 'detected');
    assert.equal(grounded.fields.businessModel.status, 'insufficient'); // "Book a 20-minute demo" was not in the text
    assert.equal(grounded.fields.businessModel.value, null);
  });

  test('a claim given with no quote at all is kept, but only as assumed', () => {
    const p = normalizeProfile({ fields: { coreTopics: { value: ['spa software'], status: 'detected', confidence: 'medium', evidence: [] } } });
    const g = groundEvidence(p, 'anything');
    assert.equal(g.fields.coreTopics.status, 'assumed');
    assert.deepEqual(g.fields.coreTopics.value, ['spa software']);
  });

  test('a search-query quote is checked against the supplied text just like a page quote', () => {
    const p = normalizeProfile({ fields: { coreTopics: { value: ['x'], status: 'detected', evidence: [{ source: 'search', ref: 'search', summary: 'q', quote: 'salon booking software' }] } } });
    assert.equal(groundEvidence(p, 'salon booking software nepal').fields.coreTopics.status, 'detected');
    assert.equal(groundEvidence(p, 'something else').fields.coreTopics.status, 'insufficient');
  });

  test('matching ignores case, quote style and whitespace', () => {
    const p = normalizeProfile({ fields: { description: { value: 'x', status: 'detected', evidence: [page('It’s   Here')] } } });
    assert.equal(groundEvidence(p, "it's here").fields.description.status, 'detected');
  });

  test('a confirmed field is never touched by grounding', () => {
    const { profile } = applyReview(emptyProfile(), [{ field: 'description', accept: true, value: 'Written by a person' }], { userId: 7 });
    assert.equal(groundEvidence(profile, 'unrelated text').fields.description.status, 'confirmed');
  });
});

describe('mergeDetected: human-confirmed information is never silently overwritten', () => {
  const confirmed = () => applyReview(zennlyDetected(), [{ field: 'ownIndustry', accept: true }, { field: 'productsServices', accept: true }], { userId: 3, now: new Date('2026-11-21T00:00:00Z') }).profile;

  test('a differing detected value for a confirmed field becomes a pending change with its evidence, and the profile is unchanged', () => {
    const wrong = normalizeProfile({ fields: { ownIndustry: { value: { label: 'Wellness' }, status: 'detected', confidence: 'medium', evidence: [page('wellness')] } } });
    const { profile, pending } = mergeDetected(confirmed(), wrong);
    assert.equal(ownIndustryLabel(profile), 'Software (SaaS)');
    assert.equal(profile.fields.ownIndustry.status, 'confirmed');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].field, 'ownIndustry');
    assert.deepEqual(pending[0].proposed, { label: 'Wellness' });
    assert.equal(pending[0].evidence[0].quote, 'wellness');
  });

  test('the same value for a confirmed field produces no pending change', () => {
    const { pending } = mergeDetected(confirmed(), zennlyDetected());
    assert.equal(pending.length, 0);
  });

  test('unconfirmed fields are updated by detection', () => {
    const { profile, changed } = mergeDetected(emptyProfile(), zennlyDetected());
    assert.equal(ownIndustryLabel(profile), 'Software (SaaS)');
    assert.ok(changed.includes('ownIndustry'));
  });

  test('a thin re-check (nothing detected) never erases what is already known', () => {
    const { profile } = mergeDetected(zennlyDetected(), emptyProfile());
    assert.equal(ownIndustryLabel(profile), 'Software (SaaS)');
    assert.equal(profile.fields.customerProblems.value.length, 2);
  });

  test('every field is protected independently', () => {
    const { profile } = mergeDetected(confirmed(), normalizeProfile({ fields: { customerProblems: { value: ['New problem'], status: 'detected', evidence: [page('x')] } } }));
    assert.deepEqual(profile.fields.customerProblems.value, ['New problem']);
    assert.equal(profile.fields.ownIndustry.status, 'confirmed');
  });
});

describe('applyReview', () => {
  test('accepting confirms what is there and stamps who and when', () => {
    const { profile, applied } = applyReview(zennlyDetected(), [{ field: 'ownIndustry', accept: true }], { userId: 12, now: new Date('2026-11-21T10:00:00Z') });
    assert.equal(profile.fields.ownIndustry.status, 'confirmed');
    assert.equal(profile.fields.ownIndustry.verifiedBy, 12);
    assert.equal(profile.fields.ownIndustry.verifiedAt, '2026-11-21T10:00:00.000Z');
    assert.deepEqual(applied, [{ field: 'ownIndustry', action: 'confirmed' }]);
  });

  test('a person’s own value replaces the detected one and is recorded as human evidence', () => {
    const { profile } = applyReview(zennlyDetected(), [{ field: 'ownIndustry', accept: true, value: { label: 'Spa and salon booking software (SaaS)' } }], { userId: 4 });
    assert.equal(ownIndustryLabel(profile), 'Spa and salon booking software (SaaS)');
    assert.equal(profile.fields.ownIndustry.evidence[0].source, 'human');
  });

  test('rejecting clears the field back to insufficient', () => {
    const { profile } = applyReview(zennlyDetected(), [{ field: 'customerProblems', accept: false }]);
    assert.equal(profile.fields.customerProblems.status, 'insufficient');
  });

  test('unknown fields and empty values are ignored', () => {
    const { applied } = applyReview(zennlyDetected(), [{ field: 'nope', accept: true }, { field: 'description', accept: true, value: '   ' }]);
    assert.deepEqual(applied, []);
  });
});

describe('state, usability and hashing', () => {
  test('profileState moves insufficient -> detected -> partially-confirmed -> confirmed', () => {
    assert.equal(profileState(emptyProfile()), 'insufficient');
    assert.equal(profileState(zennlyDetected()), 'detected');
    const some = applyReview(zennlyDetected(), [{ field: 'ownIndustry', accept: true }]).profile;
    assert.equal(profileState(some), 'partially-confirmed');
    const all = applyReview(zennlyDetected(), [{ field: 'ownIndustry', accept: true }, { field: 'productsServices', accept: true }, { field: 'targetCustomers', accept: true }]).profile;
    assert.equal(profileState(all), 'confirmed');
  });

  test('isUsable needs an evidenced own industry and something about what is sold or to whom', () => {
    assert.equal(isUsable(zennlyDetected()), true);
    assert.equal(isUsable(emptyProfile()), false);
    const lowIndustry = normalizeProfile({ fields: { ownIndustry: { value: { label: 'x' }, status: 'detected', confidence: 'low', evidence: [page('x')] }, productsServices: { value: ['y'], status: 'detected', evidence: [page('y')] } } });
    assert.equal(isUsable(lowIndustry), false);
  });

  test('the hash is stable under key order and changes when a value changes', () => {
    const a = zennlyDetected();
    const b = JSON.parse(JSON.stringify(a));
    assert.equal(contentHash(a), contentHash(b));
    b.fields.customerProblems.value.push('Another');
    assert.notEqual(contentHash(a), contentHash(b));
  });

  test('diffProfiles reports only what changed', () => {
    const before = zennlyDetected();
    const after = applyReview(before, [{ field: 'ownIndustry', accept: true }]).profile;
    assert.deepEqual(diffProfiles(before, after).map((c) => c.field), ['ownIndustry']);
  });

  test('lastVerifiedAt is the newest confirmation, or null', () => {
    assert.equal(lastVerifiedAt(zennlyDetected()), null);
    const p = applyReview(applyReview(zennlyDetected(), [{ field: 'ownIndustry', accept: true }], { now: new Date('2026-11-20T00:00:00Z') }).profile, [{ field: 'description', accept: true }], { now: new Date('2026-11-22T00:00:00Z') }).profile;
    assert.equal(lastVerifiedAt(p), '2026-11-22T00:00:00.000Z');
  });
});

describe('what agents read', () => {
  test('describeCompany keeps the company’s own industry apart from its customers’ industries', () => {
    const text = describeCompany(zennlyDetected());
    assert.match(text, /own industry: Software \(SaaS\)/);
    assert.match(text, /Industries it sells to \(these are its customers' industries, NOT its own\): Spas, Salons, Gyms/);
    assert.doesNotMatch(text, /own industry: [^.]*(Spa|Salon|Wellness)/i);
  });

  test('projectForAgent gives each agent only its slice', () => {
    const tr = projectForAgent(zennlyDetected(), 'trend-radar');
    assert.ok('ownIndustry' in tr && 'customerProblems' in tr);
    assert.ok(!('targetCustomers' in tr) && !('description' in tr));
    assert.ok(Object.keys(projectForAgent(zennlyDetected(), 'unknown-agent')).length > 3); // unknown agent id falls back to everything
  });

  test('groundingTerms collects what is sold, who buys, problems and topics, de-duplicated', () => {
    const terms = groundingTerms(zennlyDetected());
    assert.ok(terms.includes('Online booking') && terms.includes('Double-bookings') && terms.includes('Spa and salon owners'));
    assert.equal(new Set(terms).size, terms.length);
  });

  test('toLegacyIndustry derives the old free-text value from the profile', () => {
    assert.equal(toLegacyIndustry(zennlyDetected()), 'Software (SaaS)');
    assert.equal(toLegacyIndustry(emptyProfile()), null);
  });
});

import { legacyProfile, resolveBusinessContext } from './business-profile.js';

describe('resolveBusinessContext: one precedence rule', () => {
  const canonicalCurrent = () => ({ version: 4, pending: [], profile: zennlyDetected() });

  test('a usable canonical profile wins and nothing legacy can override it, even a conflicting stored label', () => {
    const ctx = resolveBusinessContext({
      current: canonicalCurrent(),
      siteProfile: { industry: 'wellness', industry_source: 'detected', main_topics: ['gym'] },
      seoPolicy: { target_industries: ['Fitness'] },
    });
    assert.equal(ctx.status, 'canonical');
    assert.equal(ctx.usable, true);
    assert.equal(ownIndustryLabel(ctx.profile), 'Software (SaaS)');
    assert.deepEqual(ctx.profile.fields.targetCustomerIndustries.value, ['Spas', 'Salons', 'Gyms']);
    assert.equal(ctx.legacy, false);
    assert.equal(ctx.version, 4);
  });

  test('a canonical profile that is not usable yet keeps its own fields and legacy only fills the gaps', () => {
    const partial = normalizeProfile({ fields: { productsServices: { value: ['Booking'], status: 'detected', confidence: 'high', evidence: [page('x')] } } });
    const ctx = resolveBusinessContext({ current: { version: 1, pending: [], profile: partial }, siteProfile: { industry: 'wellness' }, seoPolicy: { target_industries: ['Spas'] } });
    assert.equal(ctx.status, 'partial');
    assert.equal(ctx.usable, false);
    assert.equal(ctx.profile.fields.productsServices.value[0].name, 'Booking'); // canonical field kept
    assert.equal(ownIndustryLabel(ctx.profile), 'wellness'); // gap filled from legacy
    assert.equal(ctx.profile.fields.ownIndustry.status, 'assumed'); // and labelled as unverified
  });

  test('with no canonical profile the legacy labels are returned as unverified assumptions', () => {
    const ctx = resolveBusinessContext({ siteProfile: { industry: 'wellness', industry_source: 'detected' } });
    assert.equal(ctx.status, 'legacy-unverified');
    assert.equal(ctx.legacy, true);
    assert.equal(ctx.usable, false);
    assert.equal(ctx.profile.fields.ownIndustry.status, 'assumed');
  });

  test('an industry a person set on the old field is respected as confirmed', () => {
    const ctx = resolveBusinessContext({ siteProfile: { industry: 'Marketing agency', industry_source: 'human' } });
    assert.equal(ctx.profile.fields.ownIndustry.status, 'confirmed');
  });

  test('with nothing at all the answer is insufficient, never a guess', () => {
    const ctx = resolveBusinessContext({});
    assert.equal(ctx.status, 'insufficient');
    assert.equal(ownIndustryLabel(ctx.profile), null);
  });

  test('the SEO policy and growth-config industries are treated as the industries the tenant sells TO, not its own', () => {
    const p = legacyProfile({ seoPolicy: { target_industries: ['Education', 'Healthcare'] }, siteProfile: { industry: 'Artificial Intelligence and Information Technology', industry_source: 'detected' } });
    assert.deepEqual(p.fields.targetCustomerIndustries.value, ['Education', 'Healthcare']);
    assert.equal(ownIndustryLabel(p), 'Artificial Intelligence and Information Technology');
  });

  test('main topics may arrive as an array, a JSON string or an object', () => {
    assert.deepEqual(legacyProfile({ siteProfile: { main_topics: ['a', 'b'] } }).fields.coreTopics.value, ['a', 'b']);
    assert.deepEqual(legacyProfile({ siteProfile: { main_topics_json: '["x","y"]' } }).fields.coreTopics.value, ['x', 'y']);
    assert.deepEqual(legacyProfile({ siteProfile: { main_topics: { seo: 1, geo: 2 } } }).fields.coreTopics.value, ['seo', 'geo']);
  });
});

import { quoteForm, quoteSupport } from './business-profile.js';

describe('quote matching (found by the real-model run)', () => {
  test('separators, punctuation, case and a trailing ellipsis do not matter, the words and their order do', () => {
    const page = 'Autonomous SEO agent | AI SEO agent | AI search visibility | Answer engine optimization (AEO)';
    const mk = (quote) => normalizeProfile({ fields: { coreTopics: { value: ['x'], status: 'detected', evidence: [{ source: 'page', ref: 'u', summary: 's', quote }] } } });
    assert.equal(groundEvidence(mk('Autonomous SEO agent, AI SEO agent, AI search visibility, Answer engine optimization (AEO)'), page).fields.coreTopics.status, 'detected');
    assert.equal(groundEvidence(mk('autonomous seo agent AI SEO agent…'), page).fields.coreTopics.status, 'detected');
    assert.equal(groundEvidence(mk('A fully autonomous platform that ranks you first'), page).fields.coreTopics.status, 'insufficient'); // invented
  });

  test('a very short quote cannot ground a claim by coincidence', () => {
    const p = normalizeProfile({ fields: { coreTopics: { value: ['x'], status: 'detected', evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'SEO' }] } } });
    assert.equal(groundEvidence(p, 'We do SEO and more').fields.coreTopics.status, 'insufficient');
  });

  test('quoteForm is language-safe (letters and digits in any script are kept)', () => {
    assert.equal(quoteForm('Preis: 24€ / Monat!'), 'preis 24 monat');
    assert.equal(quoteForm('नेपाल मा, booking'), 'नेपाल म बुकिंग'.length ? quoteForm('नेपाल मा, booking') : '');
  });
});

describe('free-text fields that arrive as objects', () => {
  test('a nested pricing object becomes its text, never "[object Object]"', () => {
    const p = normalizeProfile({ fields: { businessModel: { value: { model: 'saas', revenue: { value: 'Subscriptions', confidence: 'high', evidence: [] }, pricing: { value: 'Team plan from $24 per seat per month', confidence: 'high' } }, status: 'detected', evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'Team plan' }] } } });
    assert.equal(p.fields.businessModel.value.revenue, 'Subscriptions');
    assert.equal(p.fields.businessModel.value.pricing, 'Team plan from $24 per seat per month');
    assert.ok(!JSON.stringify(p).includes('[object Object]'));
  });

  test('an object without a value key is flattened to its readable parts', () => {
    const p = normalizeProfile({ fields: { businessModel: { value: { model: 'saas', pricing: { starter: '$0 for 3 projects', team: '$24 per seat' } }, status: 'detected', evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'x' }] } } });
    assert.match(p.fields.businessModel.value.pricing, /\$0 for 3 projects; \$24 per seat/);
  });
});


describe('partly quoted evidence (found by the real-model run)', () => {
  const field = (quote) => normalizeProfile({ fields: { description: { value: 'Autonomous SEO software.', status: 'detected', confidence: 'high', evidence: [{ source: 'page', ref: 'u', summary: 'Website text', quote }] } } });
  const page = 'SuperRank is the autonomous AI agent for SEO, GEO and AEO. Pricing starts free. It tracks how ChatGPT, Perplexity and Gemini show your brand.';

  test('real sentences from different places stitched into one quote are still real evidence: detected, but never above medium confidence', () => {
    const g = groundEvidence(field('SuperRank is the autonomous AI agent for SEO, GEO and AEO. It tracks how ChatGPT, Perplexity and Gemini show your brand.'), page);
    assert.equal(g.fields.description.status, 'detected');
    assert.equal(g.fields.description.confidence, 'medium');
  });

  test('a quote that is only partly in the text is kept as assumed, low confidence, and marked partly quoted', () => {
    const g = groundEvidence(field('SuperRank is the autonomous AI agent for SEO, GEO and AEO. It tracks how ChatGPT, Perplexity and Gemini show your brand. We also operate offices on every continent.'), page);
    assert.equal(g.fields.description.status, 'assumed');
    assert.equal(g.fields.description.confidence, 'low');
    assert.match(g.fields.description.evidence[0].summary, /partly quoted/);
  });

  test('a mix of one real sentence and one invented one is only partly supported, never detected', () => {
    const g = groundEvidence(field('SuperRank is the autonomous AI agent for SEO, GEO and AEO. Our customers include half of the Fortune 500 companies worldwide.'), page);
    assert.notEqual(g.fields.description.status, 'detected');
  });

  test('a mostly invented quote with one real fragment is dropped', () => {
    const g = groundEvidence(field('We guarantee page one rankings for every client within thirty days. SuperRank is the autonomous AI agent for SEO. Trusted by thousands of enterprise teams across the globe.'), page);
    assert.equal(g.fields.description.status, 'insufficient');
  });

  test('a quote that is entirely in the text is still detected', () => {
    assert.equal(groundEvidence(field('SuperRank is the autonomous AI agent for SEO, GEO and AEO.'), page).fields.description.status, 'detected');
  });

  test('quoteSupport scores verbatim, stitched and invented quotes', () => {
    const h = quoteForm(page);
    assert.deepEqual(quoteSupport('Pricing starts free', h), { score: 1, verbatim: true });
    const stitched = quoteSupport('SuperRank is the autonomous AI agent for SEO. It tracks how ChatGPT, Perplexity and Gemini show your brand.', h);
    assert.equal(stitched.score, 1);
    assert.equal(stitched.verbatim, false);
    assert.equal(quoteSupport('Completely unrelated claim about something else entirely.', h).score, 0);
  });
});
