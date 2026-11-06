import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import {
  proposeProductCapability, createProductCapability, reviewProposedCapability, listCapabilitiesForReview, getProductCapabilities,
} from './data-analyst.js';

// Real DB. The guarantees that matter are all SQL: a review can only act on a row that is still 'proposed', only on the
// project it belongs to, and a decision a person made is never undone by a later proposal.

const siteIds = [];
async function makeSite(label) {
  const stamp = `cap-review-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone) VALUES ('capability-review.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const propose = (siteId, name, evidence = `We offer ${name.toLowerCase()} to local customers.`) =>
  proposeProductCapability(siteId, { name, description: `${name}.`, details: { evidence, source: 'https://x.test' } });

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM product_capabilities WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('reviewing what discovery proposed (real DB)', () => {
  test('a proposal can be approved, and becomes visible to everything that reads verified', async () => {
    const siteId = await makeSite('approve');
    const row = await propose(siteId, 'Teeth Whitening');
    assert.equal((await getProductCapabilities(siteId, 'verified')).length, 0, 'invisible until approved');
    const out = await reviewProposedCapability(siteId, row.id, 'verified');
    assert.equal(out.status, 'verified');
    assert.deepEqual((await getProductCapabilities(siteId, 'verified')).map((r) => r.name), ['Teeth Whitening']);
  });

  test('approving can fix the machine\'s wording', async () => {
    const siteId = await makeSite('edit');
    const row = await propose(siteId, 'Teeth Whitening Services Offered');
    const out = await reviewProposedCapability(siteId, row.id, 'verified', { name: 'Teeth whitening', description: 'Professional whitening.' });
    assert.equal(out.name, 'Teeth whitening');
    assert.equal(out.description, 'Professional whitening.');
  });

  test('a blank edit keeps the original rather than erasing it', async () => {
    const siteId = await makeSite('blank');
    const row = await propose(siteId, 'Dental Implants');
    const out = await reviewProposedCapability(siteId, row.id, 'verified', { name: '   ', description: '' });
    assert.equal(out.name, 'Dental Implants');
  });

  test('a rejected proposal is never proposed again', async () => {
    const siteId = await makeSite('reject');
    const row = await propose(siteId, 'Orthodontic Braces');
    await reviewProposedCapability(siteId, row.id, 'rejected');
    assert.equal(await propose(siteId, 'orthodontic braces'), null, 'a person said no; the same name must not come back');
    assert.equal((await getProductCapabilities(siteId, 'verified')).length, 0);
  });

  test('a decision already made cannot be flipped through the review route', async () => {
    const siteId = await makeSite('decided');
    const row = await propose(siteId, 'Emergency Dental Care');
    await reviewProposedCapability(siteId, row.id, 'verified');
    assert.equal(await reviewProposedCapability(siteId, row.id, 'rejected'), null, 'verified must not be rejectable by a stale screen');
    assert.equal((await getProductCapabilities(siteId, 'verified')).length, 1);
  });

  test('a person-added capability is untouchable by the review path', async () => {
    const siteId = await makeSite('human');
    const row = await createProductCapability(siteId, { name: 'Lettings management', kind: 'capability' });
    assert.equal(await reviewProposedCapability(siteId, row.id, 'rejected'), null);
  });

  test('one project cannot review another project\'s proposals', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    const row = await propose(a, 'Secret Service');
    assert.equal(await reviewProposedCapability(b, row.id, 'verified'), null);
    assert.equal((await listCapabilitiesForReview(a)).proposed.length, 1, 'still waiting on its own project');
  });

  test('only approve and reject are valid decisions', async () => {
    const siteId = await makeSite('invalid');
    const row = await propose(siteId, 'Something Offered');
    await assert.rejects(() => reviewProposedCapability(siteId, row.id, 'proposed'), /decision must be/);
    await assert.rejects(() => reviewProposedCapability(siteId, row.id, 'maybe'), /decision must be/);
  });

  test('the review list shows what is waiting first, with the sentence it came from', async () => {
    const siteId = await makeSite('list');
    await createProductCapability(siteId, { name: 'Already Confirmed', kind: 'capability' });
    await propose(siteId, 'Waiting For Review', 'We offer waiting for review to everyone.');
    const out = await listCapabilitiesForReview(siteId);
    assert.deepEqual(out.proposed.map((r) => r.name), ['Waiting For Review']);
    assert.equal(out.proposed[0].evidence, 'We offer waiting for review to everyone.');
    assert.equal(out.proposed[0].source_page, 'https://x.test');
    assert.deepEqual(out.verified.map((r) => r.name), ['Already Confirmed']);
  });

  test('rejected items do not appear in the review list at all', async () => {
    const siteId = await makeSite('hidden');
    const row = await propose(siteId, 'Not Ours');
    await reviewProposedCapability(siteId, row.id, 'rejected');
    const out = await listCapabilitiesForReview(siteId);
    assert.equal(out.proposed.length + out.verified.length, 0);
  });

  test('a project with nothing returns two empty lists, not an error', async () => {
    const siteId = await makeSite('empty');
    assert.deepEqual(await listCapabilitiesForReview(siteId), { proposed: [], verified: [] });
  });
});
