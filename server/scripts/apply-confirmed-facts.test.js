import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfirmedProfile, loadFacts, ALLOWED_SITES } from './apply-confirmed-facts.js';
import { emptyProfile } from '../lib/business-profile.js';

describe('apply-confirmed-facts', () => {
  test('sets only the description, confirmed by a person, with human evidence', () => {
    const p = buildConfirmedProfile(null, 'Chayce Properties is X.', { actor: 'owner', now: new Date('2026-11-23T00:00:00Z') });
    assert.equal(p.fields.description.value, 'Chayce Properties is X.');
    assert.equal(p.fields.description.status, 'confirmed');
    assert.equal(p.fields.description.verifiedBy, 'owner');
    assert.equal(p.fields.description.evidence[0].source, 'human');
    assert.equal(p.fields.productsServices.value, null);
  });

  test('keeps every other field of an existing profile exactly as it was', () => {
    const cur = emptyProfile();
    cur.fields.ownIndustry = { value: { label: 'Removals' }, status: 'confirmed', confidence: 'high', evidence: [], verifiedAt: '2026-01-01T00:00:00Z', verifiedBy: 'a' };
    cur.fields.description = { value: 'old', status: 'detected', confidence: 'low', evidence: [{ source: 'page', ref: 'r', summary: 's' }] };
    const p = buildConfirmedProfile(cur, 'new text', { actor: 'owner' });
    assert.deepEqual(p.fields.ownIndustry.value, { label: 'Removals' });
    assert.equal(p.fields.ownIndustry.verifiedBy, 'a');
    assert.equal(p.fields.description.value, 'new text');
  });

  test('the shipped facts file is valid, covers the six projects and fits the profile limit', () => {
    const facts = loadFacts();
    assert.deepEqual(Object.keys(facts).map(Number).sort((a, b) => a - b), [...ALLOWED_SITES].sort((a, b) => a - b));
    for (const f of Object.values(facts)) assert.ok(f.description.length > 40 && f.description.length <= 1200, f.name);
  });

  test('the confirmed facts say what the owner confirmed and nothing the owner ruled out', () => {
    const f = loadFacts();
    assert.match(f[1].description, /2018/);
    assert.match(f[1].description, /Sanepa/);
    assert.match(f[1].description, /1-10/);
    assert.match(f[1].description, /Zennly/);
    assert.match(f[8864].description, /NN2 6EZ/);
    assert.match(f[8864].description, /07708 925432/);
    assert.match(f[8874].description, /Bangalore/);
    assert.match(f[8871].description, /\$95/);
    // the banned Admizz phrase and the word "consultancy" must never be seeded into a prompt as a positive example
    assert.doesNotMatch(f[8862].description, /study abroad partner in Nepal/i);
    assert.doesNotMatch(f[8862].description, /consultan/i);
  });

  test('refuses a project that is not one of the six', () => {
    assert.equal(ALLOWED_SITES.has(9999), false);
  });
});
