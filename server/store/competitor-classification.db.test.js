import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { upsertCompetitorClassification, listCompetitorsByKind, upsertCompetitorProfile } from './competitor-profiles.js';

// Real DB (migration 232): the columns, the CHECK constraints, the first_seen_at/emerging rules and the site_id
// filter. Two sites share a competitor domain on purpose — a query that forgot site_id would leak one project's
// competitor research into the other and fail here.

const siteIds = [];
async function makeSite(label) {
  const stamp = `competitor-classification-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('competitor-classification.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM competitor_profiles WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('competitor classification (real DB)', () => {
  test('stores a business competitor with its evidence and reads it back', async () => {
    const siteId = await makeSite('store');
    const evidence = { serpQueryHits: 8, queriesChecked: 10, serviceTermOverlap: 0.6 };
    await upsertCompetitorClassification(siteId, 'rival.com', { kind: 'business', relevanceScore: 0.72, classification: evidence });
    const [row] = await listCompetitorsByKind(siteId, 'business');
    assert.equal(row.domain, 'rival.com');
    assert.equal(row.relevance_score, 0.72);
    assert.equal(row.classification.serpQueryHits, 8);
  });

  test('a first sighting is emerging; a re-run of the same domain is not', async () => {
    const siteId = await makeSite('emerging');
    const first = await upsertCompetitorClassification(siteId, 'new.com', { kind: 'business', relevanceScore: 0.5 });
    assert.equal(first.emerging, true);
    const second = await upsertCompetitorClassification(siteId, 'new.com', { kind: 'business', relevanceScore: 0.6 });
    assert.equal(second.emerging, false);
    assert.equal(Number(second.relevance_score), 0.6);
  });

  test('first_seen_at is never moved by a later run', async () => {
    const siteId = await makeSite('firstseen');
    const old = new Date('2026-01-01T00:00:00Z');
    const first = await upsertCompetitorClassification(siteId, 'old.com', { kind: 'organic', runAt: old });
    await upsertCompetitorClassification(siteId, 'old.com', { kind: 'organic', runAt: new Date() });
    const { rows } = await query('SELECT first_seen_at FROM competitor_profiles WHERE site_id = $1 AND domain = $2', [siteId, 'old.com']);
    assert.equal(rows[0].first_seen_at.toISOString(), first.first_seen_at.toISOString());
    assert.equal(rows[0].first_seen_at.toISOString(), old.toISOString());
  });

  test('classification is per site: one project cannot see another project\'s research', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await upsertCompetitorClassification(a, 'shared.com', { kind: 'business', relevanceScore: 0.9, classification: { secret: 'a-only' } });
    await upsertCompetitorClassification(b, 'shared.com', { kind: 'organic', relevanceScore: 0.1 });
    assert.deepEqual((await listCompetitorsByKind(a, 'business')).map((r) => r.domain), ['shared.com']);
    assert.deepEqual(await listCompetitorsByKind(b, 'business'), []);
    const [bRow] = await listCompetitorsByKind(b, 'organic');
    assert.equal(bRow.classification?.secret, undefined);
  });

  test('business competitors come back strongest-evidence-first', async () => {
    const siteId = await makeSite('order');
    await upsertCompetitorClassification(siteId, 'weak.com', { kind: 'business', relevanceScore: 0.2 });
    await upsertCompetitorClassification(siteId, 'strong.com', { kind: 'business', relevanceScore: 0.8 });
    await upsertCompetitorClassification(siteId, 'mid.com', { kind: 'business', relevanceScore: 0.5 });
    assert.deepEqual((await listCompetitorsByKind(siteId, 'business')).map((r) => r.domain), ['strong.com', 'mid.com', 'weak.com']);
  });

  test('an excluded platform is never returned as a competitor of any kind', async () => {
    const siteId = await makeSite('excluded');
    await upsertCompetitorClassification(siteId, 'facebook.com', { kind: null, excludedReason: 'platform' });
    for (const kind of ['business', 'organic', 'keyword_specific']) {
      assert.deepEqual(await listCompetitorsByKind(siteId, kind), []);
    }
  });

  test('an unknown kind is refused by the table rather than stored', async () => {
    const siteId = await makeSite('kindcheck');
    await assert.rejects(
      () => upsertCompetitorClassification(siteId, 'x.com', { kind: 'rival' }),
      /competitor_profiles_kind_check/
    );
  });

  test('a relevance score outside 0..1 is refused', async () => {
    const siteId = await makeSite('scorecheck');
    await assert.rejects(
      () => upsertCompetitorClassification(siteId, 'x.com', { kind: 'business', relevanceScore: 1.5 }),
      /relevance_score_check/
    );
  });

  test('classification and the older page comparison can share a row without erasing each other', async () => {
    const siteId = await makeSite('coexist');
    const runAt = new Date();
    await upsertCompetitorProfile(siteId, 'rival.com', { ourScore: 1, theirScore: 2 }, runAt);
    await upsertCompetitorClassification(siteId, 'rival.com', { kind: 'business', relevanceScore: 0.6 });
    const { rows } = await query('SELECT comparison, kind, relevance_score::float AS rs FROM competitor_profiles WHERE site_id = $1 AND domain = $2', [siteId, 'rival.com']);
    assert.equal(rows[0].comparison.theirScore, 2);
    assert.equal(rows[0].kind, 'business');
    assert.equal(rows[0].rs, 0.6);
  });

  test('rows written before this migration keep a null kind and are not reinterpreted', async () => {
    const siteId = await makeSite('legacy');
    await upsertCompetitorProfile(siteId, 'legacy.com', { ourScore: 1 }, new Date());
    const { rows } = await query('SELECT kind, emerging FROM competitor_profiles WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].kind, null);
    assert.equal(rows[0].emerging, false);
  });

  test('deleting a site removes its competitor research', async () => {
    const siteId = await makeSite('cascade');
    await upsertCompetitorClassification(siteId, 'rival.com', { kind: 'business', relevanceScore: 0.5 });
    await query('DELETE FROM sites WHERE id = $1', [siteId]);
    const { rows } = await query('SELECT count(*)::int AS n FROM competitor_profiles WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 0);
  });
});
