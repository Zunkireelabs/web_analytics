import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../db.js';
import { measureOne, measurementWindows } from './fix-impact.js';
import { getSiteSearchTotals } from '../../store/fix-impact.js';

// The whole measuring path against real rows: real gsc_breakdown (the page), real gsc_daily (the site-wide control),
// a real fix_impact row, and the outcome that reaches generator_outcomes. The unit tests mock the store; this is what
// proves the SQL and the column names. measureOne is called with one explicit row, so no other project's due
// measurements are touched.

const siteIds = [];
async function makeSite(label) {
  const stamp = `fix-impact-evidence-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('fix-impact-evidence.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM generator_outcomes WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM fix_impact WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM gsc_breakdown WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM gsc_daily WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

const MERGED_AT = '2026-06-15T00:00:00Z';
const PAGE = '/pricing';
const W = measurementWindows(MERGED_AT);

// One row per day across a window.
async function seedDays(table, siteId, { start, end, clicksPerDay, impressionsPerDay, page = null }) {
  const days = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  for (const day of days) {
    if (table === 'gsc_breakdown') {
      await query(`INSERT INTO gsc_breakdown (site_id, date, dim_type, dim_value, clicks, impressions, ctr, position) VALUES ($1,$2,'page',$3,$4,$5,0.01,10)`, [siteId, day, page, clicksPerDay, impressionsPerDay]);
    } else {
      await query(`INSERT INTO gsc_daily (site_id, date, clicks, impressions, ctr, position) VALUES ($1,$2,$3,$4,0.01,10)`, [siteId, day, clicksPerDay, impressionsPerDay]);
    }
  }
}

async function scenario(label, { page, site }) {
  const siteId = await makeSite(label);
  await seedDays('gsc_breakdown', siteId, { ...W.before, clicksPerDay: page.before, impressionsPerDay: page.before * 100, page: PAGE });
  await seedDays('gsc_breakdown', siteId, { ...W.after, clicksPerDay: page.after, impressionsPerDay: page.after * 100, page: PAGE });
  if (site) {
    await seedDays('gsc_daily', siteId, { ...W.before, clicksPerDay: site.before, impressionsPerDay: site.before * 100 });
    await seedDays('gsc_daily', siteId, { ...W.after, clicksPerDay: site.after, impressionsPerDay: site.after * 100 });
  }
  const { rows: d } = await query(`INSERT INTO drafts (site_id, action_type, input, content, status) VALUES ($1,'faq','{}'::jsonb,'{}'::jsonb,'implemented') RETURNING id`, [siteId]);
  const { rows: fi } = await query(
    `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status)
     VALUES ($1,$2,$3,'faq',$4, now() - interval '1 day','pending') RETURNING *`,
    [siteId, d[0].id, PAGE, MERGED_AT]
  );
  await measureOne(fi[0]);
  const { rows: after } = await query('SELECT status, delta FROM fix_impact WHERE id = $1', [fi[0].id]);
  const { rows: outcomes } = await query(`SELECT outcome, detail FROM generator_outcomes WHERE site_id = $1 AND outcome LIKE 'impact-%'`, [siteId]);
  return { siteId, impact: after[0], outcomes };
}

describe('measureOne against real rows', () => {
  test('getSiteSearchTotals sums the real daily series and is null for a window with no data', async () => {
    const siteId = await makeSite('totals');
    await seedDays('gsc_daily', siteId, { start: '2026-05-01', end: '2026-05-10', clicksPerDay: 7, impressionsPerDay: 700 });
    const t = await getSiteSearchTotals(siteId, '2026-05-01', '2026-05-10');
    assert.equal(t.clicks, 70);
    assert.equal(t.impressions, 7000);
    assert.equal(await getSiteSearchTotals(siteId, '2025-01-01', '2025-01-10'), null);
  });

  test('a page that doubled while the site stayed flat is recorded as a supported win, with its evidence', async () => {
    const r = await scenario('win', { page: { before: 10, after: 20 }, site: { before: 100, after: 100 } });
    assert.equal(r.impact.status, 'measured');
    assert.equal(r.impact.delta.verdict, 'impact-positive');
    assert.equal(r.impact.delta.verdictReason, 'supported');
    assert.equal(r.impact.delta.evidence.siteChangePct, 0);
    assert.equal(r.impact.delta.evidence.pageChangePct, 100);
    assert.deepEqual(r.outcomes.map((o) => o.outcome), ['impact-positive']);
    assert.match(r.outcomes[0].detail, /relative to the site's own trend/);
  });

  test('a page that doubled while the whole site doubled is inconclusive and teaches nothing about the generator', async () => {
    const r = await scenario('with-site', { page: { before: 10, after: 20 }, site: { before: 100, after: 200 } });
    assert.equal(r.impact.delta.verdict, 'impact-inconclusive');
    assert.equal(r.impact.delta.verdictReason, 'moved-with-site');
    assert.deepEqual(r.outcomes.map((o) => o.outcome), ['impact-neutral']);
    assert.match(r.outcomes[0].detail, /^inconclusive \(moved-with-site\)/);
  });

  test('a page that fell while the whole site was flat is a supported loss', async () => {
    const r = await scenario('loss', { page: { before: 20, after: 8 }, site: { before: 100, after: 100 } });
    assert.equal(r.impact.delta.verdict, 'impact-negative');
    assert.deepEqual(r.outcomes.map((o) => o.outcome), ['impact-negative']);
  });

  test('no site-wide data to compare against is inconclusive, never assumed to be a win', async () => {
    const r = await scenario('no-control', { page: { before: 10, after: 20 }, site: null });
    assert.equal(r.impact.delta.verdictReason, 'no-site-control');
    assert.deepEqual(r.outcomes.map((o) => o.outcome), ['impact-neutral']);
  });

  test('the correlation caveat is stored with every measurement', async () => {
    const r = await scenario('caveat', { page: { before: 10, after: 20 }, site: { before: 100, after: 100 } });
    assert.match(r.impact.delta.caveat, /correlation, not attribution/);
  });
});
