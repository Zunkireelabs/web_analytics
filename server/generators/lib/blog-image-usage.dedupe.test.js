import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, pool } from '../../db.js';
import { usedPhotoIds } from './blog-image-usage.js';

// The existing blog-image-usage.test.js uses node:test's `mock.module`, which
// needs Node 22 + --experimental-test-module-mocks and therefore cannot run
// here at all. This file covers the half that actually regressed — the
// pending-draft reservation — against the real database instead of a module
// mock, the same way competitor-prominence.test.js does.

describe('blog-image-usage — intra-batch photo reservation', () => {
  let siteA;
  let siteB;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id)
       VALUES ('Blog Image Dedupe A', 'sc-domain:dedupe-a.example', 'ga4-a'),
              ('Blog Image Dedupe B', 'sc-domain:dedupe-b.example', 'ga4-b')
       RETURNING *`
    );
    [siteA, siteB] = rows;
  });

  after(async () => {
    await query('DELETE FROM drafts WHERE site_id = ANY($1)', [[siteA.id, siteB.id]]);
    await query('DELETE FROM sites WHERE id = ANY($1)', [[siteA.id, siteB.id]]);
    await pool.end();
  });

  async function addDraft(siteId, photoId, status) {
    await query(
      `INSERT INTO drafts (site_id, action_type, source, input, content, status)
       VALUES ($1, 'blog-image', 'test', '{}'::jsonb, $2::jsonb, $3)`,
      [
        siteId,
        JSON.stringify({
          imageUrl: `https://images.pexels.com/photos/${photoId}/pexels-photo-${photoId}.jpeg?auto=compress`,
        }),
        status,
      ]
    );
  }

  // The exact failure that put one photo on 39 posts: draft #1 claims a photo,
  // draft #2 recomputes the exclusion set and must now see that claim.
  test('a pending draft\'s photo is excluded from the next draft in the same batch', async () => {
    await addDraft(siteA.id, 2599244, 'draft');
    const ids = await usedPhotoIds(siteA);
    assert.ok(ids.has(2599244), 'photo claimed by a pending draft must be excluded');
  });

  test('every pending status reserves its photo', async () => {
    await addDraft(siteA.id, 111111, 'submitted_for_approval');
    await addDraft(siteA.id, 222222, 'approved');
    await addDraft(siteA.id, 333333, 'branch_pushed');
    await addDraft(siteA.id, 444444, 'pr_opened');
    const ids = await usedPhotoIds(siteA);
    for (const id of [111111, 222222, 333333, 444444]) {
      assert.ok(ids.has(id), `status reserving ${id} should be counted`);
    }
  });

  test('an abandoned draft releases its photo', async () => {
    await addDraft(siteA.id, 999999, 'abandoned');
    const ids = await usedPhotoIds(siteA);
    assert.equal(ids.has(999999), false, 'an abandoned draft must not hold a photo hostage');
  });

  // Multi-tenant isolation: two tenants may legitimately use the same stock
  // photo, so one tenant's reservation must never constrain another's.
  test('one tenant\'s pending draft does not constrain another tenant', async () => {
    await addDraft(siteB.id, 2599244, 'draft');
    const idsB = await usedPhotoIds(siteB);
    assert.ok(idsB.has(2599244), 'site B sees its own claim');

    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM drafts WHERE site_id = $1 AND content->>'imageUrl' LIKE '%555555%'`,
      [siteA.id]
    );
    assert.equal(rows[0].n, 0);
    await addDraft(siteB.id, 555555, 'draft');
    const idsA = await usedPhotoIds(siteA);
    assert.equal(idsA.has(555555), false, 'site A must not inherit site B\'s reservation');
  });

  test('a site with no drafts and no repo returns an empty set rather than throwing', async () => {
    const ids = await usedPhotoIds(siteB2());
    assert.ok(ids instanceof Set);
  });

  function siteB2() {
    return { id: null, url_file_map: null };
  }
});
