import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const isLocal = (() => { try { return ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();
const dbm = await import('../db.js');
let skip = isLocal ? false : 'not a local database';
if (!skip) { try { await dbm.query('SELECT 1 FROM gsc_screen_daily LIMIT 1'); } catch (e) { skip = `no local database (${e.code || e.message})`; } }

describe('the Overview reads Search Console screen numbers', { skip }, () => {
  const created = [];
  after(async () => { for (const id of created) await dbm.query('DELETE FROM sites WHERE id = $1', [id]).catch(() => {}); });

  test('screen days win over final own-domain days; a day without one falls back; the range reaches the freshest screen day', async () => {
    const { getDailySeries, getRangeTotals, getScreenDataRange, getDataRange } = await import('./read.js');
    const { upsertGscScreenDays } = await import('./upsert.js');
    const d = `gx${crypto.randomBytes(3).toString('hex')}.test`;
    const site = await dbm.createClientSite({ name: `gx-${d}`, websiteDomain: d, timezone: 'UTC', propertyType: 'website' });
    created.push(site.id);
    // Final, own-domain-only totals, ending 3 days behind (what gsc_daily holds today).
    for (const [day, imp] of [['2026-11-13', 100], ['2026-11-14', 100], ['2026-11-15', 100]]) {
      await dbm.query(`INSERT INTO gsc_daily (site_id, date, clicks, impressions, ctr, position) VALUES ($1,$2,5,$3,0.05,4)`, [site.id, day, imp]);
    }
    // Search Console's screen: more impressions (every subdomain), and two fresher days.
    await upsertGscScreenDays(site.id, [
      { date: '2026-11-14', clicks: 9, impressions: 160, ctr: 0.056, position: 5 },
      { date: '2026-11-15', clicks: 9, impressions: 170, ctr: 0.053, position: 5 },
      { date: '2026-11-16', clicks: 7, impressions: 140, ctr: 0.05, position: 5 },
      { date: '2026-11-17', clicks: 2, impressions: 60, ctr: 0.03, position: 6 },
    ]);
    const series = await getDailySeries(site.id, '2026-11-13', '2026-11-17');
    assert.deepEqual(series.map((r) => Number(r.impressions)), [100, 160, 170, 140, 60]);
    const t = await getRangeTotals(site.id, '2026-11-13', '2026-11-17');
    assert.equal(Number(t.impressions), 630);
    assert.equal((await getScreenDataRange(site.id)).freshest, '2026-11-17');
    assert.equal((await getDataRange(site.id)).freshest, '2026-11-15', 'the Analyst and reports still see only final days');
  });

  test('re-reading a day replaces it (fresh numbers move until Google finalises them)', async () => {
    const { upsertGscScreenDays } = await import('./upsert.js');
    const d = `gy${crypto.randomBytes(3).toString('hex')}.test`;
    const site = await dbm.createClientSite({ name: `gy-${d}`, websiteDomain: d, timezone: 'UTC', propertyType: 'website' });
    created.push(site.id);
    await upsertGscScreenDays(site.id, [{ date: '2026-11-17', clicks: 1, impressions: 20, ctr: 0.05, position: 7 }]);
    await upsertGscScreenDays(site.id, [{ date: '2026-11-17', clicks: 3, impressions: 55, ctr: 0.05, position: 7 }]);
    const { rows } = await dbm.query('SELECT impressions FROM gsc_screen_daily WHERE site_id = $1', [site.id]);
    assert.deepEqual(rows.map((r) => r.impressions), [55]);
  });
});
