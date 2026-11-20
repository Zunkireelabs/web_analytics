import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildView, reviewProfile, refreshProfile, GROUPS, FIELD_LABELS } from './business-profile-service.js';
import { normalizeProfile, FIELD_KEYS, ownIndustryLabel, applyReview } from './business-profile.js';

const ev = [{ source: 'page', ref: 'https://zennly.io/', summary: 'Website text', quote: 'Spa & Salon Booking Software in Nepal' }];
const F = (value, status = 'detected') => ({ value, status, confidence: 'high', evidence: ev });
const profile = () => normalizeProfile({ fields: {
  description: F('Booking software for spas and salons.'), ownIndustry: F({ label: 'Software (SaaS)' }), subIndustry: F('Spa and salon booking software'),
  productsServices: F([{ name: 'Online booking' }]), businessModel: F({ model: 'saas' }), targetCustomers: F([{ segment: 'Spa and salon owners' }]),
  targetCustomerIndustries: F(['Spas', 'Salons']), customerProblems: F(['Double-bookings']), coreTopics: F(['salon booking software']),
} });
const current = (over = {}) => ({ version: 2, status: 'detected', profile: profile(), pending: [], source: 'system', reason: 'weekly', createdAt: '2026-11-20T00:00:00Z', ...over });

describe('buildView', () => {
  test('every field appears in exactly one group, and the five concepts are kept apart', () => {
    const all = GROUPS.flatMap((g) => g.fields);
    assert.deepEqual([...all].sort(), [...FIELD_KEYS].sort());
    assert.equal(new Set(all).size, all.length);
    assert.ok(all.every((k) => FIELD_LABELS[k]));
    const own = GROUPS.find((g) => g.fields.includes('ownIndustry')); const cust = GROUPS.find((g) => g.fields.includes('targetCustomerIndustries'));
    assert.notEqual(own.key, cust.key);
    assert.match(cust.hint, /not the company’s own industry/);
  });

  test('a project with no profile says so plainly and is entirely insufficient', () => {
    const v = buildView(null);
    assert.equal(v.exists, false);
    assert.equal(v.state, 'insufficient');
    assert.equal(v.counts.insufficient, FIELD_KEYS.length);
  });

  test('fields carry status, confidence, evidence quotes, who verified, and any pending change', () => {
    const pending = [{ field: 'ownIndustry', proposed: { label: 'Wellness' }, evidence: ev, current: { label: 'Software (SaaS)' } }];
    const v = buildView(current({ pending }));
    const own = v.groups.flatMap((g) => g.fields).find((f) => f.key === 'ownIndustry');
    assert.equal(own.status, 'detected');
    assert.equal(own.evidence[0].quote, 'Spa & Salon Booking Software in Nepal');
    assert.equal(own.pending.proposed.label, 'Wellness');
    assert.equal(own.required, true);
    assert.equal(v.pending.length, 1);
    assert.equal(v.counts.detected, 9);
  });

  test('last verified and the confirmed count reflect a person’s review', () => {
    const confirmed = applyReview(profile(), [{ field: 'ownIndustry', accept: true }], { userId: 4, now: new Date('2026-11-21T09:00:00Z') }).profile;
    const v = buildView(current({ profile: confirmed }));
    assert.equal(v.lastVerifiedAt, '2026-11-21T09:00:00.000Z');
    assert.equal(v.counts.confirmed, 1);
    assert.equal(v.state, 'partially-confirmed');
  });
});

describe('reviewProfile', () => {
  const deps = (cur, saved = []) => ({ getCurrent: async () => cur, save: async (id, body) => { saved.push({ id, body }); return { version: (cur?.version || 0) + 1 }; }, audit: async (e) => { saved.push({ audit: e }); } });

  test('confirming a field stamps the reviewer, writes a human version for this project, and is audited', async () => {
    const log = [];
    const out = await reviewProfile(8872, { edits: [{ field: 'ownIndustry', accept: true }] }, { id: 12 }, deps(current(), log));
    assert.equal(out.ok, true);
    const save = log.find((x) => x.body);
    assert.equal(save.id, 8872);
    assert.equal(save.body.source, 'human');
    assert.equal(save.body.actor, 12);
    assert.equal(save.body.reason, 'review');
    assert.equal(save.body.profile.fields.ownIndustry.status, 'confirmed');
    assert.equal(save.body.profile.fields.ownIndustry.verifiedBy, 12);
    assert.equal(log.find((x) => x.audit).audit.action, 'business_profile.reviewed');
  });

  test('a person can correct a field, and only the fields they name change', async () => {
    const log = [];
    await reviewProfile(1, { edits: [{ field: 'subIndustry', accept: true, value: 'Spa and salon management software' }] }, { id: 1 }, deps(current(), log));
    const p = log.find((x) => x.body).body.profile;
    assert.equal(p.fields.subIndustry.value, 'Spa and salon management software');
    assert.equal(p.fields.subIndustry.status, 'confirmed');
    assert.equal(p.fields.ownIndustry.status, 'detected'); // untouched
  });

  test('accepting a detected change applies it as the person’s confirmed value; dismissing keeps the confirmed value and drops the finding', async () => {
    const confirmed = applyReview(profile(), [{ field: 'ownIndustry', accept: true }, { field: 'subIndustry', accept: true }], { userId: 3 }).profile;
    const pending = [
      { field: 'ownIndustry', proposed: { label: 'Marketing technology' }, evidence: ev },
      { field: 'subIndustry', proposed: 'Something else', evidence: ev },
    ];
    const log = [];
    const out = await reviewProfile(1, { decisions: [{ field: 'ownIndustry', decision: 'accept' }, { field: 'subIndustry', decision: 'dismiss' }] }, { id: 9 }, deps(current({ profile: confirmed, pending }), log));
    assert.equal(out.ok, true);
    const body = log.find((x) => x.body).body;
    assert.equal(ownIndustryLabel(body.profile), 'Marketing technology');
    assert.equal(body.profile.fields.ownIndustry.verifiedBy, 9);
    assert.equal(body.profile.fields.subIndustry.value, 'Spa and salon booking software'); // dismissed: unchanged
    assert.deepEqual(body.pending, []); // both findings are resolved
    const actions = body.applied.map((a) => a.action);
    assert.ok(actions.includes('accepted-detected-change') && actions.includes('dismissed-detected-change'), JSON.stringify(actions));
    assert.ok(actions.includes('edited'), 'the accepted value was applied as the person\'s own edit');
  });

  test('a decision for a field with nothing pending, or an unknown field, is ignored (a stale screen cannot change anything)', async () => {
    const out = await reviewProfile(1, { decisions: [{ field: 'ownIndustry', decision: 'accept' }, { field: 'nonsense', decision: 'accept' }] }, { id: 1 }, deps(current()));
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
  });

  test('a project with no profile yet is a 404 with a clear message, and nothing is written', async () => {
    const log = [];
    const out = await reviewProfile(1, { edits: [{ field: 'ownIndustry', accept: true }] }, { id: 1 }, deps(null, log));
    assert.equal(out.status, 404);
    assert.equal(log.length, 0);
  });

  test('an empty request changes nothing', async () => {
    const log = [];
    const out = await reviewProfile(1, { edits: [], decisions: [] }, { id: 1 }, deps(current(), log));
    assert.equal(out.ok, false);
    assert.equal(log.length, 0);
  });

  test('clearing a field also clears any pending finding for it', async () => {
    const log = [];
    await reviewProfile(1, { edits: [{ field: 'customerProblems', accept: false }] }, { id: 1 }, deps(current({ pending: [{ field: 'customerProblems', proposed: ['x'] }] }), log));
    const body = log.find((x) => x.body).body;
    assert.equal(body.profile.fields.customerProblems.status, 'insufficient');
    assert.deepEqual(body.pending, []);
  });
});

describe('refreshProfile', () => {
  test('runs the engine for this project only, and audits what happened', async () => {
    const calls = [];
    const out = await refreshProfile(8872, { id: 5 }, { refresh: async (id, o) => { calls.push([id, o]); return { ok: true, insufficient: false, changed: ['ownIndustry'], pending: [{}] }; }, audit: async (e) => { calls.push(e); } });
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0], [8872, { reason: 'refresh' }]);
    assert.equal(calls[1].action, 'business_profile.refreshed');
    assert.equal(calls[1].metadata.pending, 1);
  });

  test('an audit failure never breaks the request', async () => {
    const out = await refreshProfile(1, { id: 1 }, { refresh: async () => ({ ok: true }), audit: async () => { throw new Error('audit down'); } });
    assert.equal(out.ok, true);
  });
});
