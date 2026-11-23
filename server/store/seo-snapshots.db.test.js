import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import {
  getBaseline, getBaselines, insertSnapshot, acceptLatestAsBaseline, pruneSnapshots, ownChangesSince, latestSnapshots,
} from './seo-snapshots.js';

// Real DB: the point is the SQL. Two projects are planted so "scoped to the site" is checked, not assumed. Fixtures carry a unique
// marker and are removed afterwards (snapshots go with their site).
const TAG = `seo-snapshots-db-${Date.now()}`;
const siteIds = [];
let workspaceId;

async function site(label) {
  if (!workspaceId) workspaceId = (await query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${TAG}-ws`])).rows[0].id;
  const stamp = `${TAG}-${label}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone, workspace_id, website_domain) VALUES ($1, $2, $2, 'UTC', $3, $4) RETURNING id`,
    [`${TAG} ${label}`, stamp, workspaceId, `${label}.${TAG}.example`],
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const snap = (over = {}) => ({
  statusCode: 200, title: 'T', metaDescription: 'D', canonical: 'https://x.example/a/', robots: null, h1: ['H'], h2: ['A', 'B'],
  schemaTypes: ['Article'], schemaHash: 'h', openGraph: { 'og:title': 't' }, contentHash: 'c', wordCount: 10, ...over,
});
const URL_A = 'https://x.example/a/';

after(async () => {
  if (siteIds.length) await query('DELETE FROM sites WHERE id = ANY($1)', [siteIds]); // snapshots and drafts cascade
  if (workspaceId) await query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  await pool.end();
});

describe('baselines', () => {
  test('a baseline round-trips every field, including the JSON ones', async () => {
    const s1 = await site('roundtrip');
    await insertSnapshot(s1, URL_A, snap({ title: 'Hello' }), { baselineReason: 'first-capture' });
    const b = await getBaseline(s1, URL_A);
    assert.equal(b.title, 'Hello');
    assert.deepEqual(b.h2, ['A', 'B']);
    assert.deepEqual(b.schemaTypes, ['Article']);
    assert.deepEqual(b.openGraph, { 'og:title': 't' });
    assert.equal(b.isBaseline, true);
    assert.equal(b.baselineReason, 'first-capture');
    assert.equal(await getBaseline(s1, 'https://x.example/never-seen/'), null);
  });

  test('a new baseline REPLACES the old one: there is always exactly one', async () => {
    const s1 = await site('one-baseline');
    await insertSnapshot(s1, URL_A, snap({ title: 'old' }), { baselineReason: 'first-capture' });
    await insertSnapshot(s1, URL_A, snap({ title: 'mid' }));                                  // a plain capture
    await insertSnapshot(s1, URL_A, snap({ title: 'new' }), { baselineReason: 'own-change' });
    const { rows } = await query('SELECT title, is_baseline FROM seo_page_snapshots WHERE site_id = $1 AND url = $2 ORDER BY id', [s1, URL_A]);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.filter((r) => r.is_baseline).map((r) => r.title), ['new']);
    assert.equal((await getBaseline(s1, URL_A)).baselineReason, 'own-change');
  });

  test('the database itself refuses a second baseline for a page', async () => {
    const s1 = await site('unique');
    await insertSnapshot(s1, URL_A, snap(), { baselineReason: 'first-capture' });
    await assert.rejects(query(`INSERT INTO seo_page_snapshots (site_id, url, is_baseline, baseline_reason) VALUES ($1, $2, true, 'accepted')`, [s1, URL_A]), /seo_page_snapshots_one_baseline|duplicate key/);
  });

  test('a reason outside the allowed list is refused', async () => {
    const s1 = await site('reason');
    await assert.rejects(query(`INSERT INTO seo_page_snapshots (site_id, url, is_baseline, baseline_reason) VALUES ($1, $2, true, 'because')`, [s1, URL_A]), /check/i);
  });

  test('getBaselines reads several pages at once and skips pages without one', async () => {
    const s1 = await site('many');
    await insertSnapshot(s1, 'https://x.example/1/', snap(), { baselineReason: 'first-capture' });
    await insertSnapshot(s1, 'https://x.example/2/', snap(), { baselineReason: 'first-capture' });
    await insertSnapshot(s1, 'https://x.example/3/', snap()); // captured but never a baseline
    const m = await getBaselines(s1, ['https://x.example/1/', 'https://x.example/2/', 'https://x.example/3/', 'https://x.example/4/']);
    assert.deepEqual([...m.keys()].sort(), ['https://x.example/1/', 'https://x.example/2/']);
    assert.equal((await getBaselines(s1, [])).size, 0);
  });
});

describe('accepting a change as intended', () => {
  test('the latest capture becomes the baseline, marked "accepted"', async () => {
    const s1 = await site('accept');
    await insertSnapshot(s1, URL_A, snap({ title: 'before' }), { baselineReason: 'first-capture' });
    await insertSnapshot(s1, URL_A, snap({ title: 'after the change' }));
    const accepted = await acceptLatestAsBaseline(s1, URL_A);
    assert.equal(accepted.title, 'after the change');
    assert.equal(accepted.baselineReason, 'accepted');
    assert.equal((await getBaseline(s1, URL_A)).title, 'after the change');
    const { rows } = await query('SELECT count(*)::int AS n FROM seo_page_snapshots WHERE site_id = $1 AND url = $2 AND is_baseline', [s1, URL_A]);
    assert.equal(rows[0].n, 1);
  });

  test('a page never captured returns null and changes nothing', async () => {
    assert.equal(await acceptLatestAsBaseline(await site('accept-none'), 'https://x.example/nope/'), null);
  });

  test('can only ever touch the caller\'s own project', async () => {
    const mine = await site('mine'); const theirs = await site('theirs');
    await insertSnapshot(theirs, URL_A, snap({ title: 'theirs-before' }), { baselineReason: 'first-capture' });
    await insertSnapshot(theirs, URL_A, snap({ title: 'theirs-latest' }));
    assert.equal(await acceptLatestAsBaseline(mine, URL_A), null, 'same URL, other project: nothing to accept');
    assert.equal((await getBaseline(theirs, URL_A)).title, 'theirs-before', 'their baseline is untouched');
  });
});

describe('pruning', () => {
  test('keeps the newest 30 plain captures and never the baseline', async () => {
    const s1 = await site('prune');
    await insertSnapshot(s1, URL_A, snap({ title: 'baseline' }), { baselineReason: 'first-capture' });
    for (let i = 1; i <= 35; i += 1) await insertSnapshot(s1, URL_A, snap({ title: `c${i}` }));
    await pruneSnapshots(s1, URL_A, 30);
    const { rows } = await query('SELECT title, is_baseline FROM seo_page_snapshots WHERE site_id = $1 AND url = $2 ORDER BY id', [s1, URL_A]);
    assert.equal(rows.filter((r) => !r.is_baseline).length, 30);
    assert.equal(rows.filter((r) => r.is_baseline).length, 1);
    assert.equal(rows.find((r) => r.title === 'c1'), undefined, 'the oldest plain capture is gone');
    assert.ok(rows.find((r) => r.title === 'c35'), 'the newest is kept');
  });
});

describe('our own changes', () => {
  async function draft(siteId, page, status, implementedAt) {
    await query(
      `INSERT INTO drafts (site_id, action_type, input, content, status, implemented_at) VALUES ($1, 'meta-title', $2::jsonb, '{}'::jsonb, $3, $4)`,
      [siteId, JSON.stringify({ page }), status, implementedAt],
    );
  }
  test('lists pages with a fix that went live since the date, lowercased, latest time per page', async () => {
    const s1 = await site('own'); const other = await site('own-other');
    await draft(s1, '/Blog/Post/', 'implemented', '2026-11-05T00:00:00Z');
    await draft(s1, '/Blog/Post/', 'implemented', '2026-11-09T00:00:00Z');
    await draft(s1, 'https://x.example/Pricing/', 'implemented', '2026-11-07T00:00:00Z');
    await draft(s1, '/old/', 'implemented', '2026-10-01T00:00:00Z');      // before the date
    await draft(s1, '/pending/', 'draft', null);                          // never went live
    await draft(other, '/other-project/', 'implemented', '2026-11-08T00:00:00Z');
    const m = await ownChangesSince(s1, new Date('2026-11-01T00:00:00Z'));
    assert.deepEqual([...m.keys()].sort(), ['/blog/post/', 'https://x.example/pricing/']);
    assert.equal(m.get('/blog/post/').toISOString(), '2026-11-09T00:00:00.000Z');
  });
});

test('latestSnapshots returns the newest capture of each page', async () => {
  const s1 = await site('latest');
  await insertSnapshot(s1, 'https://x.example/1/', snap({ title: 'old' }), { baselineReason: 'first-capture' });
  await insertSnapshot(s1, 'https://x.example/1/', snap({ title: 'newer' }));
  await insertSnapshot(s1, 'https://x.example/2/', snap({ title: 'only' }), { baselineReason: 'first-capture' });
  const rows = await latestSnapshots(s1);
  assert.deepEqual(rows.map((r) => [r.url, r.title]).sort(), [['https://x.example/1/', 'newer'], ['https://x.example/2/', 'only']]);
});
