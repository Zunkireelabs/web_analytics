import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence, detectProfile, refreshBusinessProfile, enrichWithCapabilities, pickInventoryPages, buildEvidenceDigest, EXTRACTION_SYSTEM, extractionToProfile } from './business-intelligence.js';
import { normalizeProfile, applyReview, ownIndustryLabel, describeCompany, emptyProfile, profileState } from './business-profile.js';

// Small hand-written pages that say what the real ones say (the live-site runs with a real model are in business-intelligence.llm.test.js).
const ZENNLY_HOME = `<html><head><title>Spa & Salon Booking Software in Nepal | Zennly</title>
<meta name="description" content="Stop double-bookings and discount leakage. Booking, staff, payroll, payments and reports for spas, salons and gyms in Nepal. Book a 20-minute demo."></head>
<body><nav><a href="/features">Features</a><a href="/pricing">Pricing</a></nav><main>
<h1>Built for the businesses that run without the chaos</h1>
<p>Zennly is software for spa and salon owners. One system for every branch: online booking, staff scheduling, payroll, payments and reports. Give your business the same technology as the big chains.</p>
<h2>Stop double-bookings and discount leakage</h2><p>Owners lose revenue to empty gaps in the calendar and to staff discounts nobody approved. Zennly shows every branch in one place so owners stay in control.</p></main></body></html>`;
const ZENNLY_FEATURES = `<html><head><title>Features | Zennly</title></head><body><main><h1>Features</h1>
<p>Online booking for clients, staff scheduling and payroll, payments, client records and retention reports for spas, salons and gyms.</p></main></body></html>`;

const pagesFor = (map) => async (u) => {
  const href = typeof u === 'string' ? u : u.toString();
  const html = map[href] || map[new URL(href).pathname];
  if (!html) throw new Error(`404 ${href}`);
  const url = new URL(href);
  return { html, finalUrl: url };
};
const site = { id: 8872, website_domain: 'zennly.io' };
const goodExtraction = () => ({
  description: { value: 'Booking and business management software for spas and salons.', confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'Zennly is software for spa and salon owners' }] },
  ownIndustry: { value: { label: 'Software (SaaS)' }, confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'Spa & Salon Booking Software in Nepal' }] },
  subIndustry: { value: 'Spa and salon booking and management software', confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'Booking, staff, payroll, payments and reports for spas, salons and gyms' }] },
  businessModel: { value: { model: 'saas', revenue: null, pricing: null }, confidence: 'medium', evidence: [{ ref: 'https://zennly.io/', quote: 'Book a 20-minute demo' }] },
  productsServices: { value: [{ name: 'Online booking' }, { name: 'Staff scheduling and payroll' }], confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'online booking, staff scheduling, payroll, payments and reports' }] },
  targetCustomerIndustries: { value: ['Spas', 'Salons', 'Gyms'], confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'for spas, salons and gyms in Nepal' }] },
  targetCustomers: { value: [{ segment: 'Spa and salon owners' }], confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'software for spa and salon owners' }] },
  customerProblems: { value: ['Double-bookings', 'Discount leakage'], confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'Stop double-bookings and discount leakage' }] },
  geographicMarkets: { value: ['Nepal'], confidence: 'medium', evidence: [{ ref: 'https://zennly.io/', quote: 'in Nepal' }] },
  competitorCategories: { value: { include: ['salon and spa management software'], exclude: ['directories', 'software review sites'] } },
  coreTopics: { value: ['salon booking software', 'spa management', 'staff scheduling'], confidence: 'medium', evidence: [{ ref: 'search', quote: 'salon booking software' }] },
});
const baseDeps = (over = {}) => {
  const saved = [];
  return {
    saved,
    deps: {
      getSite: async (id) => (id === 8872 ? site : null),
      fetchPage: pagesFor({ 'https://zennly.io/': ZENNLY_HOME, '/features': ZENNLY_FEATURES }),
      normalizeUrl: (d) => new URL(`https://${d}/`),
      inventoryPaths: async () => [],
      topQueries: async () => ['salon booking software', 'spa appointment app'],
      capabilities: async () => [],
      onboarding: async () => null,
      llm: async () => goodExtraction(),
      getCurrent: async () => null,
      save: async (id, body) => { saved.push({ id, body }); return { unchanged: false, version: 1 }; },
      ...over,
    },
  };
};

describe('the extraction prompt', () => {
  test('keeps a company’s own industry apart from its customers’ industries, and treats pricing as its own claim', () => {
    assert.match(EXTRACTION_SYSTEM, /NOT in the salon or wellness industry/);
    assert.match(EXTRACTION_SYSTEM, /targetCustomerIndustries: the industries of its CUSTOMERS\. These are NOT the company's own industry/);
    assert.match(EXTRACTION_SYSTEM, /pricing is null/);
    assert.match(EXTRACTION_SYSTEM, /copied EXACTLY/);
  });

  test('the model is never shown the project’s existing industry label (that would be circular evidence)', async () => {
    const { deps } = baseDeps({ llm: async (system, user) => { assert.doesNotMatch(system + user, /wellness industry label|recorded as/i); return goodExtraction(); } });
    // The profile on file says "wellness"; the digest is built only from pages and queries.
    deps.getCurrent = async () => ({ version: 3, profile: normalizeProfile({ fields: { ownIndustry: { value: { label: 'Wellness' }, status: 'detected', confidence: 'high', evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }] } } }), pending: [] });
    const out = await refreshBusinessProfile(8872, { deps });
    assert.equal(out.ok, true);
  });
});

describe('Zennly (software for salons): not a wellness business', () => {
  test('own industry is software, customers are salons and spas, and the evidence is quoted from the page', async () => {
    const { deps, saved } = baseDeps();
    const out = await refreshBusinessProfile(8872, { deps });
    assert.equal(out.ok, true);
    assert.equal(out.insufficient, false);
    const p = saved[0].body.profile;
    assert.equal(ownIndustryLabel(p), 'Software (SaaS)');
    assert.deepEqual(p.fields.targetCustomerIndustries.value, ['Spas', 'Salons', 'Gyms']);
    assert.equal(p.fields.businessModel.value.model, 'saas');
    assert.equal(p.fields.businessModel.value.pricing, null); // never assumed
    assert.equal(p.fields.ownIndustry.status, 'detected');
    assert.match(p.fields.ownIndustry.evidence[0].quote, /Spa & Salon Booking Software/);
    const text = describeCompany(p);
    assert.match(text, /own industry: Software \(SaaS\)/);
    assert.match(text, /NOT its own\): Spas, Salons, Gyms/);
    assert.doesNotMatch(ownIndustryLabel(p), /wellness|fitness|spa|salon/i);
  });

  test('competitor categories are an unverified assumption, never presented as detected', async () => {
    const { deps, saved } = baseDeps();
    await refreshBusinessProfile(8872, { deps });
    assert.equal(saved[0].body.profile.fields.competitorCategories.status, 'assumed');
  });
});

describe('honesty about evidence', () => {
  test('a quote the model invented is dropped, and the field becomes insufficient rather than a fabricated claim', async () => {
    const bad = goodExtraction();
    bad.ownIndustry = { value: { label: 'Wellness' }, confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'We are the leading wellness provider in Asia' }] };
    const { deps, saved } = baseDeps({ llm: async () => bad });
    await refreshBusinessProfile(8872, { deps });
    assert.equal(saved[0].body.profile.fields.ownIndustry.status, 'insufficient');
    assert.equal(ownIndustryLabel(saved[0].body.profile), null);
  });

  test('thin evidence returns insufficient-data and never calls the model', async () => {
    const { deps, saved } = baseDeps({
      fetchPage: pagesFor({ 'https://zennly.io/': '<html><head><title>Hi</title></head><body><main>Coming soon</main></body></html>' }),
      llm: async () => { throw new Error('the model must not be called without evidence'); },
    });
    const out = await refreshBusinessProfile(8872, { deps });
    assert.equal(out.insufficient, true);
    assert.equal(saved[0].body.profile.fields.ownIndustry.status, 'insufficient');
    assert.equal(profileState(saved[0].body.profile), 'insufficient');
  });

  test('a project with no website, or an unreachable one, is insufficient with a specific reason', async () => {
    const none = baseDeps({ getSite: async () => ({ id: 8872, website_domain: null }), llm: async () => { throw new Error('no'); } });
    assert.equal((await refreshBusinessProfile(8872, { deps: none.deps })).reason, 'no-website');
    const down = baseDeps({ fetchPage: async () => { throw new Error('ECONNREFUSED'); }, llm: async () => { throw new Error('no'); } });
    assert.equal((await refreshBusinessProfile(8872, { deps: down.deps })).reason, 'fetch-failed');
  });

  test('an unknown project does nothing', async () => {
    const { deps, saved } = baseDeps();
    assert.deepEqual(await refreshBusinessProfile(999, { deps }), { ok: false, reason: 'no-site' });
    assert.equal(saved.length, 0);
  });

  test('a thin re-check never erases an existing profile or writes a new version', async () => {
    const existing = normalizeProfile(goodExtraction() && extractionToProfile(goodExtraction()));
    const { deps, saved } = baseDeps({
      fetchPage: async () => { throw new Error('down'); },
      getCurrent: async () => ({ version: 5, profile: existing, pending: [] }),
      llm: async () => { throw new Error('no'); },
    });
    const out = await refreshBusinessProfile(8872, { deps });
    assert.equal(out.insufficient, true);
    assert.deepEqual(out.saved, { unchanged: true, version: 5 });
    assert.equal(saved.length, 0);
  });
});

describe('confirmed information is protected', () => {
  test('a run that finds a different industry leaves the confirmed value and records a pending change with evidence', async () => {
    const confirmed = applyReview(extractionToProfile(goodExtraction()), [{ field: 'ownIndustry', accept: true }], { userId: 2 }).profile;
    const wrong = goodExtraction();
    wrong.ownIndustry = { value: { label: 'Wellness' }, confidence: 'medium', evidence: [{ ref: 'https://zennly.io/', quote: 'for spas, salons and gyms in Nepal' }] };
    const { deps, saved } = baseDeps({ llm: async () => wrong, getCurrent: async () => ({ version: 2, profile: confirmed, pending: [] }) });
    const out = await refreshBusinessProfile(8872, { deps });
    assert.equal(ownIndustryLabel(saved[0].body.profile), 'Software (SaaS)');
    assert.equal(saved[0].body.profile.fields.ownIndustry.status, 'confirmed');
    assert.equal(out.pending.length, 1);
    assert.equal(out.pending[0].field, 'ownIndustry');
    assert.deepEqual(out.pending[0].proposed, { label: 'Wellness' });
    assert.match(out.pending[0].evidence[0].quote, /spas, salons and gyms/);
  });
});

describe('what the run records', () => {
  test('the saved version carries the model usage and is attributed to the system, for this project only', async () => {
    const { deps, saved } = baseDeps();
    await refreshBusinessProfile(8872, { deps, reason: 'baseline' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 8872);
    assert.equal(saved[0].body.source, 'system');
    assert.equal(saved[0].body.reason, 'baseline');
    assert.equal(saved[0].body.usage.calls, 1);
    assert.ok(saved[0].body.usage.promptChars > 500 && saved[0].body.usage.completionChars > 100);
  });

  test('exactly one model call per run', async () => {
    let calls = 0;
    const { deps } = baseDeps({ llm: async () => { calls += 1; return goodExtraction(); } });
    await refreshBusinessProfile(8872, { deps });
    assert.equal(calls, 1);
  });
});

describe('evidence collection', () => {
  test('reads the homepage and the pages it links, and the search queries', async () => {
    const { deps } = baseDeps();
    const ev = await collectEvidence(site, deps);
    assert.equal(ev.pages.length, 2);
    assert.ok(ev.pages.some((p) => /Features/.test(p.title)));
    assert.deepEqual(ev.queries, ['salon booking software', 'spa appointment app']);
  });

  test('inventory pages: top-level about/product/pricing pages only, same origin, no articles, no duplicates', () => {
    const out = pickInventoryPages([
      '/about', '/blog/how-to-grow-a-salon', '/pricing', 'https://other.test/about', '/pricing', '/contact', '/services/hair',
    ], 'https://zennly.io', new Set()).map((u) => u.pathname);
    assert.deepEqual(out, ['/about', '/pricing', '/services/hair']);
  });

  test('verified capabilities are carried into products and audiences with capability evidence', () => {
    const p = enrichWithCapabilities(extractionToProfile(goodExtraction()), [
      { id: 11, name: 'Payroll for salon staff', kind: 'capability', description: 'Runs payroll' },
      { id: 12, name: 'Online booking', kind: 'capability' },
      { id: 13, name: 'Spa chain managers', kind: 'audience' },
    ]);
    const names = p.fields.productsServices.value.map((x) => x.name);
    assert.ok(names.includes('Payroll for salon staff'));
    assert.equal(names.filter((n) => n === 'Online booking').length, 1);
    assert.ok(p.fields.productsServices.evidence.some((e) => e.source === 'capability' && e.ref === 'product_capabilities:11'));
    assert.ok(p.fields.targetCustomers.value.some((x) => x.segment === 'Spa chain managers'));
  });

  test('the digest is capped and tells the model where search queries and the owner’s own description came from', () => {
    const d = buildEvidenceDigest({ pages: [{ url: 'https://x.test/', title: 'T', body: 'b'.repeat(40000) }], queries: ['q1', 'q2'], onboarding: { description: 'We sell software', category: 'SaaS' } });
    assert.ok(d.text.length <= 16000);
    assert.equal(d.queryCount, 2);
    const small = buildEvidenceDigest({ pages: [{ url: 'https://x.test/', title: 'T', body: 'hello world' }], queries: ['q1'], onboarding: { description: 'We sell software', category: 'SaaS' } });
    assert.match(small.text, /SEARCH QUERIES .*ref "search"/);
    assert.match(small.text, /OWNER-PROVIDED DESCRIPTION \(ref "onboarding"\)/);
  });

  test('empty profile helper is a valid starting point', () => {
    assert.equal(profileState(emptyProfile()), 'insufficient');
  });
});

import { unwrapField } from './business-intelligence.js';

describe('the shapes real models return (found by the real-model run)', () => {
  test('object-valued fields without a value wrapper are accepted', () => {
    const p = extractionToProfile({
      ownIndustry: { label: 'Software (SaaS)', confidence: 'high', evidence: [{ ref: 'https://zennly.io/', quote: 'Spa & Salon Booking Software in Nepal' }] },
      businessModel: { model: 'saas', revenue: null, pricing: null, confidence: 'medium', evidence: [{ ref: 'https://zennly.io/', quote: 'Book a 20-minute demo' }] },
    });
    assert.equal(ownIndustryLabel(p), 'Software (SaaS)');
    assert.equal(p.fields.businessModel.value.model, 'saas');
    assert.equal(p.fields.ownIndustry.confidence, 'high');
  });

  test('a bare list or string is accepted as the value', () => {
    const p = extractionToProfile({ customerProblems: ['Double-bookings', 'Discount leakage'], subIndustry: 'Spa and salon booking software' });
    assert.deepEqual(p.fields.customerProblems.value, ['Double-bookings', 'Discount leakage']);
    assert.equal(p.fields.subIndustry.value, 'Spa and salon booking software');
  });

  test('evidence given on each list item is moved up to the field, so the claim counts as evidenced', () => {
    const raw = { productsServices: { value: [
      { name: 'Full Service Marketing', description: 'Demand generation', confidence: 'high', evidence: [{ ref: 'https://mobilise.agency/services/', quote: 'Implement data-driven marketing and sales programs' }] },
      { name: 'Creative Production', confidence: 'medium', evidence: [{ ref: 'https://mobilise.agency/services/', quote: 'creative content that compels action' }] },
    ] } };
    const p = extractionToProfile(raw);
    assert.equal(p.fields.productsServices.status, 'detected');
    assert.equal(p.fields.productsServices.evidence.length, 2);
    assert.equal(p.fields.productsServices.confidence, 'medium'); // a list is only as sure as its least certain item
    assert.deepEqual(p.fields.productsServices.value.map((x) => x.name), ['Full Service Marketing', 'Creative Production']);
    assert.ok(!('evidence' in p.fields.productsServices.value[0]));
  });

  test('unwrapField leaves a correctly wrapped field alone', () => {
    const f = { value: ['a'], confidence: 'high', evidence: [] };
    assert.deepEqual(unwrapField(f), f);
    assert.equal(unwrapField(null), null);
    assert.equal(unwrapField(7), null);
  });
});
