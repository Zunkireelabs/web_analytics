import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentBusinessProfile, getBusinessProfileVersion, listBusinessProfileVersions, insertBusinessProfileVersion } from './business-profile.js';
import { normalizeProfile, contentHash, applyReview } from '../lib/business-profile.js';

// Records every statement so the tests can prove each one is scoped to a single project. (The SQL itself, the migration and the
// version/protection behaviour were also verified on a real Postgres engine, see the commit notes.)
const recorder = (rowsFor = () => []) => {
  const calls = [];
  const run = async (text, params = []) => { calls.push({ text, params }); return { rows: rowsFor(text, params) }; };
  return { run, calls };
};
const profile = () => normalizeProfile({ fields: { ownIndustry: { value: { label: 'Software (SaaS)' }, status: 'detected', confidence: 'high', evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }] } } });
const row = (p, extra = {}) => ({ id: 1, site_id: 5, version: 1, status: 'detected', profile: p, content_hash: contentHash(p), change_summary: {}, source: 'system', actor: null, reason: 'baseline', created_at: new Date('2026-11-21T00:00:00Z'), ...extra });

describe('site isolation', () => {
  test('every statement filters on site_id = $1 and passes the project id first', async () => {
    const { run, calls } = recorder(() => []);
    await getCurrentBusinessProfile(5, { run });
    await getBusinessProfileVersion(5, 2, { run });
    await listBusinessProfileVersions(5, { run });
    await insertBusinessProfileVersion(5, { profile: profile() }, { run });
    assert.ok(calls.length >= 4);
    for (const c of calls) {
      assert.match(c.text, /site_id\s*=\s*\$1/);
      assert.equal(c.params[0], 5);
    }
  });

  test('a missing, zero, negative or non-integer project id is rejected before any query', async () => {
    const { run, calls } = recorder();
    for (const bad of [undefined, null, 0, -1, 1.5, 'abc', NaN]) {
      await assert.rejects(() => getCurrentBusinessProfile(bad, { run }), TypeError);
      await assert.rejects(() => insertBusinessProfileVersion(bad, { profile: profile() }, { run }), TypeError);
    }
    assert.equal(calls.length, 0);
  });
});

describe('reading', () => {
  test('returns the newest version with its pending findings', async () => {
    const p = profile();
    const { run } = recorder(() => [row(p, { version: 4, change_summary: { pending: [{ field: 'ownIndustry', proposed: { label: 'Wellness' } }] } })]);
    const cur = await getCurrentBusinessProfile(5, { run });
    assert.equal(cur.version, 4);
    assert.equal(cur.pending.length, 1);
    assert.equal(cur.profile.fields.ownIndustry.value.label, 'Software (SaaS)');
  });

  test('no rows means null, and a missing table also means null (the system behaves as before the profile existed)', async () => {
    assert.equal(await getCurrentBusinessProfile(5, { run: async () => ({ rows: [] }) }), null);
    const missing = async () => { throw Object.assign(new Error('relation "business_profile_versions" does not exist'), { code: '42P01' }); };
    assert.equal(await getCurrentBusinessProfile(5, { run: missing }), null);
    assert.deepEqual(await listBusinessProfileVersions(5, { run: missing }), []);
  });

  test('any other database error is not swallowed', async () => {
    await assert.rejects(() => getCurrentBusinessProfile(5, { run: async () => { throw new Error('connection reset'); } }), /connection reset/);
  });
});

describe('writing', () => {
  test('identical content and pending findings are not written again', async () => {
    const p = profile();
    const { run, calls } = recorder((text) => (/SELECT/.test(text) && !/INSERT/.test(text) ? [row(p)] : []));
    const out = await insertBusinessProfileVersion(5, { profile: p }, { run });
    assert.deepEqual(out, { unchanged: true, version: 1 });
    assert.ok(!calls.some((c) => /INSERT/.test(c.text)));
  });

  test('a change inserts a new version with a status derived from the profile and the version number computed in the statement', async () => {
    const before = profile();
    const after = applyReview(before, [{ field: 'ownIndustry', accept: true }], { userId: 9 }).profile;
    const { run, calls } = recorder((text) => (/INSERT/.test(text) ? [{ id: 2, version: 2, status: 'partially-confirmed', created_at: new Date() }] : [row(before)]));
    const out = await insertBusinessProfileVersion(5, { profile: after, applied: [{ field: 'ownIndustry', action: 'confirmed' }], source: 'human', actor: 9, reason: 'review' }, { run });
    assert.equal(out.version, 2);
    const ins = calls.find((c) => /INSERT/.test(c.text));
    assert.match(ins.text, /COALESCE\(MAX\(version\), 0\) \+ 1/);
    assert.match(ins.text, /ON CONFLICT \(site_id, version\) DO NOTHING/);
    assert.equal(ins.params[1], 'partially-confirmed');
    assert.equal(ins.params[5], 'human');
    assert.equal(ins.params[6], '9');
  });

  test('a missing table skips the write instead of throwing', async () => {
    const missing = async (text) => { if (/INSERT/.test(text)) throw Object.assign(new Error('x'), { code: '42P01' }); return { rows: [] }; };
    assert.deepEqual(await insertBusinessProfileVersion(5, { profile: profile() }, { run: missing }), { skipped: 'no-table' });
  });
});
