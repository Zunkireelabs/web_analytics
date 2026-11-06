import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { getTargetPlaces, setTargetPlaces } from './target-places.js';

const siteIds = [];
async function makeSite(label) {
  const stamp = `places-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(`INSERT INTO sites (name, gsc_property, ga4_property_id, timezone) VALUES ('target-places.db.test.js fixture', $1, $2, 'UTC') RETURNING id`, [stamp, stamp]);
  siteIds.push(rows[0].id);
  return rows[0].id;
}
after(async () => {
  if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  await pool.end();
});

describe('target places (real DB, migration 241)', () => {
  test('a new site has none declared — which changes nothing about how it behaves', async () => {
    assert.deepEqual(await getTargetPlaces(await makeSite('default')), []);
  });

  test('a primary and its neighbours round-trip in priority order', async () => {
    const id = await makeSite('roundtrip');
    await setTargetPlaces(id, { primary: 'Northampton', nearby: ['Wellingborough', 'Daventry'] });
    assert.deepEqual(await getTargetPlaces(id), [
      { name: 'Northampton', tier: 'primary' }, { name: 'Wellingborough', tier: 'nearby' }, { name: 'Daventry', tier: 'nearby' },
    ]);
  });

  test('saving again replaces the list rather than adding to it', async () => {
    const id = await makeSite('replace');
    await setTargetPlaces(id, { primary: 'Northampton', nearby: ['Kettering'] });
    await setTargetPlaces(id, { primary: 'Leicester', nearby: [] });
    assert.deepEqual((await getTargetPlaces(id)).map((p) => p.name), ['Leicester']);
  });

  test('clearing it returns the site to "no declared places"', async () => {
    const id = await makeSite('clear');
    await setTargetPlaces(id, { primary: 'Northampton' });
    await setTargetPlaces(id, { primary: '', nearby: [] });
    assert.deepEqual(await getTargetPlaces(id), []);
  });

  test('nearby places with no primary are refused rather than silently promoting the first', async () => {
    const id = await makeSite('noprimary');
    await assert.rejects(() => setTargetPlaces(id, { primary: '', nearby: ['Kettering'] }), /Name the place you are based first/);
    assert.deepEqual(await getTargetPlaces(id), []);
  });

  test('junk and duplicates are cleaned on the way in', async () => {
    const id = await makeSite('clean');
    await setTargetPlaces(id, { primary: ' Northampton ', nearby: ['northampton', '', 'Kettering', 'kettering'] });
    assert.deepEqual((await getTargetPlaces(id)).map((p) => p.name), ['Northampton', 'Kettering']);
  });

  test('a site that does not exist returns null instead of pretending it saved', async () => {
    assert.equal(await setTargetPlaces(2147483000, { primary: 'Northampton' }), null);
    assert.equal(await getTargetPlaces(2147483000), null);
  });

  test('places are per site', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await setTargetPlaces(a, { primary: 'Northampton' });
    assert.deepEqual(await getTargetPlaces(b), []);
  });

  test('the table itself refuses something that is not a list', async () => {
    const id = await makeSite('check');
    await assert.rejects(() => query(`UPDATE sites SET target_places = '{"a":1}'::jsonb WHERE id = $1`, [id]), /sites_target_places_check/);
  });
});
