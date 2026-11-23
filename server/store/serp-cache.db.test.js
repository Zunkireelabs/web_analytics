import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { readSerpCache, writeSerpCache } from './serp-cache.js';

// Real DB: the point is the SQL (the upsert, the age filter, the JSON round trip). Uses a unique keyword and removes its rows.
const KEY = `serp-cache-db-test-${Date.now()}`;
after(async () => { await query('DELETE FROM serp_cache WHERE keyword_key LIKE $1', ['serp-cache-db-test-%']); await pool.end(); });
const serp = (n, paa = []) => ({ results: [{ position: 1, url: `https://r${n}.example/`, domain: `r${n}.example`, title: 'T', description: 'D' }], peopleAlsoAsk: paa, relatedSearches: ['x'], features: ['video'] });

test('round trip, upsert replaces, and the key is per market and language', async () => {
  assert.equal(await readSerpCache(KEY, 2840, 'en', 14), null);
  await writeSerpCache(KEY, 2840, 'en', serp(1, ['q1']));
  const a = await readSerpCache(KEY, 2840, 'en', 14);
  assert.deepEqual(a.results.map((r) => r.domain), ['r1.example']);
  assert.deepEqual([a.peopleAlsoAsk, a.relatedSearches, a.features], [['q1'], ['x'], ['video']]);
  await writeSerpCache(KEY, 2840, 'en', serp(2));
  assert.deepEqual((await readSerpCache(KEY, 2840, 'en', 14)).results.map((r) => r.domain), ['r2.example'], 'same key: replaced, not duplicated');
  const { rows } = await query('SELECT count(*)::int n FROM serp_cache WHERE keyword_key = $1', [KEY]);
  assert.equal(rows[0].n, 1);
  assert.equal(await readSerpCache(KEY, 2826, 'en', 14), null, 'another market is another entry');
  assert.equal(await readSerpCache(KEY, 2840, 'de', 14), null, 'another language is another entry');
});

test('an old entry is not returned', async () => {
  await writeSerpCache(`${KEY}-old`, 2840, 'en', serp(3));
  await query(`UPDATE serp_cache SET fetched_at = now() - interval '20 days' WHERE keyword_key = $1`, [`${KEY}-old`]);
  assert.equal(await readSerpCache(`${KEY}-old`, 2840, 'en', 14), null);
  assert.ok(await readSerpCache(`${KEY}-old`, 2840, 'en', 30), 'a longer window still finds it');
});
