import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import {
  addTrackedKeyword, setTrackedKeywordActive, listKeywordsToCheck, listTrackedKeywords,
  markKeywordsChecked, trackedKeywordCapacity, getOwnRankHistory, getTrackedRankMovement,
} from './rank-tracking.js';
import { saveCompetitorRankings } from './upsert.js';

// Real DB (migration 237). The cap is enforced inside the INSERT, so only real SQL can prove it holds — including
// when two adds race. The movement read is a window function over competitor_rankings, which fakes cannot check.

const siteIds = [];
async function makeSite(label, { max = 25 } = {}) {
  const stamp = `rank-tracking-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, rank_tracking_max_keywords)
     VALUES ('rank-tracking.db.test.js fixture', $1, $2, 'UTC', $3) RETURNING id`,
    [stamp, stamp, max]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const add = (siteId, keyword, over = {}) =>
  addTrackedKeyword(siteId, keyword, { locationCode: 2524, source: 'user_request', ...over });

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM competitor_rankings WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM tracked_keywords WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('the per-site cap holds in SQL', () => {
  test('adding up to the ceiling works, and the next one is refused', async () => {
    const siteId = await makeSite('cap', { max: 3 });
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await add(siteId, `keyword ${i}`)).added, true, `keyword ${i}`);
    }
    const refused = await add(siteId, 'one too many');
    assert.equal(refused.added, false);
    assert.equal(refused.reason, 'cap_reached');
    assert.equal((await listTrackedKeywords(siteId)).length, 3);
  });

  test('concurrent adds cannot both squeeze past the last slot', async () => {
    const siteId = await makeSite('race', { max: 1 });
    const results = await Promise.all([add(siteId, 'first'), add(siteId, 'second')]);
    assert.equal(results.filter((r) => r.added).length, 1, 'exactly one may win');
    assert.equal((await listTrackedKeywords(siteId)).length, 1);
  });

  test('a cap of zero means nothing can be tracked at all', async () => {
    const siteId = await makeSite('zero', { max: 0 });
    assert.equal((await add(siteId, 'anything')).reason, 'cap_reached');
  });

  test('capacity reports what is used and what is left', async () => {
    const siteId = await makeSite('capacity', { max: 2 });
    assert.deepEqual(await trackedKeywordCapacity(siteId), { max: 2, used: 0, remaining: 2 });
    await add(siteId, 'one');
    assert.deepEqual(await trackedKeywordCapacity(siteId), { max: 2, used: 1, remaining: 1 });
  });

  test('a paused keyword frees a slot but keeps its row', async () => {
    const siteId = await makeSite('pause', { max: 1 });
    const first = await add(siteId, 'paused one');
    assert.equal((await add(siteId, 'blocked')).reason, 'cap_reached');
    await setTrackedKeywordActive(siteId, first.id, false);
    assert.equal((await add(siteId, 'now fits')).added, true);
    assert.equal((await listTrackedKeywords(siteId, { includeInactive: true })).length, 2);
    assert.equal((await listTrackedKeywords(siteId)).length, 1);
  });

  test('un-pausing goes through the cap again rather than around it', async () => {
    const siteId = await makeSite('unpause', { max: 1 });
    const first = await add(siteId, 'a');
    await setTrackedKeywordActive(siteId, first.id, false);
    await add(siteId, 'b');
    assert.equal(await setTrackedKeywordActive(siteId, first.id, true), null, 'the ceiling is full again');
  });
});

describe('adding keywords', () => {
  test('the same keyword is not tracked twice, and says so', async () => {
    const siteId = await makeSite('dupe');
    await add(siteId, 'Teeth Whitening Cost');
    const again = await add(siteId, '  teeth whitening cost ');
    assert.equal(again.added, false);
    assert.equal(again.reason, 'already_tracked');
  });

  test('the same keyword in a different market is a different thing to watch', async () => {
    const siteId = await makeSite('markets');
    assert.equal((await add(siteId, 'whitening', { locationCode: 2524 })).added, true);
    assert.equal((await add(siteId, 'whitening', { locationCode: 2840 })).added, true);
  });

  test('junk input is refused before touching the ceiling', async () => {
    const siteId = await makeSite('junk');
    assert.equal((await add(siteId, '')).reason, 'invalid_keyword');
    assert.equal((await add(siteId, '   ')).reason, 'invalid_keyword');
    assert.equal((await add(siteId, 'x'.repeat(300))).reason, 'invalid_keyword');
    assert.equal((await addTrackedKeyword(siteId, 'no market', { source: 'user_request' })).reason, 'no_location');
    assert.equal((await listTrackedKeywords(siteId)).length, 0);
  });

  test('an unknown source is refused by the table', async () => {
    const siteId = await makeSite('source');
    await assert.rejects(() => add(siteId, 'kw', { source: 'guessed' }), /tracked_keywords_source_check/);
  });

  test('keywords are per site', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await add(a, 'shared keyword');
    assert.equal((await listTrackedKeywords(b)).length, 0);
  });
});

describe('which keywords a run checks', () => {
  test('longest-unchecked first, so a capped run rotates fairly', async () => {
    const siteId = await makeSite('rotate', { max: 10 });
    const first = await add(siteId, 'checked long ago');
    await add(siteId, 'never checked');
    await markKeywordsChecked(siteId, [first.id]);
    const order = (await listKeywordsToCheck(siteId, { limit: 2 })).map((r) => r.keyword);
    assert.deepEqual(order, ['never checked', 'checked long ago']);
  });

  test('the run limit is clamped by the site ceiling, so a big limit cannot overspend', async () => {
    const siteId = await makeSite('clamp', { max: 2 });
    await add(siteId, 'a');
    await add(siteId, 'b');
    assert.equal((await listKeywordsToCheck(siteId, { limit: 500 })).length, 2);
  });

  test('a paused keyword is never checked', async () => {
    const siteId = await makeSite('skip-paused');
    const k = await add(siteId, 'paused');
    await add(siteId, 'active');
    await setTrackedKeywordActive(siteId, k.id, false);
    assert.deepEqual((await listKeywordsToCheck(siteId)).map((r) => r.keyword), ['active']);
  });
});

describe('position history and movement', () => {
  async function snapshot(siteId, keyword, date, ownPosition, { rivalPosition = 1 } = {}) {
    const rows = [{ date, query: keyword, domain: 'rival.com', url: 'https://rival.com/p', position: rivalPosition, isOwnDomain: false }];
    if (ownPosition != null) {
      rows.push({ date, query: keyword, domain: 'ourclinic.com', url: 'https://ourclinic.com/p', position: ownPosition, isOwnDomain: true });
    }
    await saveCompetitorRankings(siteId, rows);
  }

  test('our own history reads back newest first', async () => {
    const siteId = await makeSite('history');
    await add(siteId, 'whitening');
    await snapshot(siteId, 'whitening', '2026-10-01', 18);
    await snapshot(siteId, 'whitening', '2026-10-08', 12);
    const history = await getOwnRankHistory(siteId, 'Whitening');
    assert.deepEqual(history.map((h) => h.position), [12, 18]);
  });

  test('improvement is reported with the right sign — lower is better', async () => {
    const siteId = await makeSite('movement');
    await add(siteId, 'whitening');
    await snapshot(siteId, 'whitening', '2026-10-01', 18);
    await snapshot(siteId, 'whitening', '2026-10-08', 12);
    const [row] = await getTrackedRankMovement(siteId);
    assert.equal(row.current_position, 12);
    assert.equal(row.previous_position, 18);
    assert.equal(row.improvement, 6, 'moving from 18 to 12 is an improvement of 6');
  });

  test('a decline is negative', async () => {
    const siteId = await makeSite('decline');
    await add(siteId, 'whitening');
    await snapshot(siteId, 'whitening', '2026-10-01', 5);
    await snapshot(siteId, 'whitening', '2026-10-08', 9);
    const [row] = await getTrackedRankMovement(siteId);
    assert.equal(row.improvement, -4);
  });

  test('a first-ever check has no movement, which is not the same as no change', async () => {
    const siteId = await makeSite('first');
    await add(siteId, 'whitening');
    await snapshot(siteId, 'whitening', '2026-10-08', 12);
    const [row] = await getTrackedRankMovement(siteId);
    assert.equal(row.current_position, 12);
    assert.equal(row.previous_position, null);
    assert.equal(row.improvement, null);
  });

  test('a keyword we do not rank for reports null, not zero', async () => {
    const siteId = await makeSite('notranking');
    await add(siteId, 'whitening');
    await snapshot(siteId, 'whitening', '2026-10-08', null);
    const [row] = await getTrackedRankMovement(siteId);
    assert.equal(row.current_position, null);
    assert.equal(row.improvement, null);
  });

  test('a tracked keyword never checked still appears, with nothing claimed about it', async () => {
    const siteId = await makeSite('unchecked');
    await add(siteId, 'never checked');
    const [row] = await getTrackedRankMovement(siteId);
    assert.equal(row.keyword, 'never checked');
    assert.equal(row.current_position, null);
    assert.equal(row.last_checked_at, null);
  });

  test('movement is per site', async () => {
    const a = await makeSite('mv-a');
    const b = await makeSite('mv-b');
    await add(a, 'whitening');
    await snapshot(a, 'whitening', '2026-10-08', 3);
    assert.deepEqual(await getTrackedRankMovement(b), []);
  });

  test('deleting a site removes its tracked keywords', async () => {
    const siteId = await makeSite('cascade');
    await add(siteId, 'kw');
    await query('DELETE FROM sites WHERE id = $1', [siteId]);
    const { rows } = await query('SELECT count(*)::int AS n FROM tracked_keywords WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 0);
  });
});
