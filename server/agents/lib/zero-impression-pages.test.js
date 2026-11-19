import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { findZeroImpressionPages, pickLinkSource, MAX_PER_SITE_PER_DAY } from './zero-impression-pages.js';

const now = new Date('2026-11-18T00:00:00Z');
const old = '2026-08-01T00:00:00Z';

describe('finding pages Google never shows', () => {
  const inventory = [
    { page: 'https://x.test/', firstSeenAt: old },
    { page: 'https://x.test/blog/seen/', firstSeenAt: old },
    { page: 'https://x.test/blog/never', firstSeenAt: old, orphaned: false },
    { page: 'https://www.x.test/services/audit', firstSeenAt: old, orphaned: true },
    { page: 'https://x.test/privacy', firstSeenAt: old },
    { page: 'https://x.test/blog/tag/seo', firstSeenAt: old },
    { page: 'https://x.test/blog/brand-new', firstSeenAt: '2026-11-10T00:00:00Z' },
    { page: 'https://x.test/files/report.pdf', firstSeenAt: old },
  ];
  const gscPages = [{ page: 'https://x.test/', impressions: 900, clicks: 40 }, { page: 'https://x.test/blog/seen', impressions: 12, clicks: 0 }];
  const out = findZeroImpressionPages({ inventory, gscPages, now });

  test('keeps only real, old-enough pages with no impressions; orphaned first', () => {
    assert.deepEqual(out.map((p) => p.page), ['https://www.x.test/services/audit', 'https://x.test/blog/never']);
  });
  test('www, trailing slash and http(s) variants are one page', () => assert.ok(!out.some((p) => p.page.includes('/blog/seen'))));
});

describe('choosing the page that links to it', () => {
  const sources = [
    { page: 'https://x.test/', clicks: 40 },
    { page: 'https://x.test/blog/popular', clicks: 9 },
    { page: 'https://x.test/blog/other', clicks: 20 },
    { page: 'https://x.test/blog/never', clicks: 0 },
  ];
  test('prefers the same section, most clicks breaking ties', () => assert.equal(pickLinkSource('https://x.test/blog/never', sources), 'https://x.test/blog/other'));
  test('falls back to the page with most clicks', () => assert.equal(pickLinkSource('https://x.test/services/audit', sources), 'https://x.test/'));
  test('never the page itself, never a page without clicks', () => assert.equal(pickLinkSource('https://x.test/', [{ page: 'https://x.test/', clicks: 5 }, { page: 'https://x.test/a', clicks: 0 }]), null));
});

// ── real local Postgres: reads the real tables, writes real recommendations, respects the daily cap and the 30-day re-queue ──
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const isLocal = (() => { try { return ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();
const dbm = await import('../../db.js');
let skip = isLocal ? false : 'not a local database';
if (!skip) { try { await dbm.query('SELECT 1 FROM page_inventory LIMIT 1'); } catch (e) { skip = `no local database (${e.code || e.message})`; } }

describe('daily sync on a real database', { skip }, () => {
  const created = [];
  after(async () => { for (const id of created) await dbm.query('DELETE FROM sites WHERE id = $1', [id]).catch(() => {}); });

  test('queues at most the daily cap, as safe link fixes from a page that earns clicks, and not again the next day', async () => {
    const { syncZeroImpressionPages } = await import('./zero-impression-pages.js');
    const d = `z${crypto.randomBytes(3).toString('hex')}.test`;
    const site = await dbm.createClientSite({ name: `zero-imp-${d}`, websiteDomain: d, timezone: 'UTC', propertyType: 'website' });
    created.push(site.id);
    const day = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const ranking = ['/', '/blog/hit', '/blog/hit2', '/blog/hit3', '/blog/hit4'];
    for (const [i, p] of ranking.entries()) {
      await dbm.query(`INSERT INTO gsc_query_page (site_id, date, query, page, clicks, impressions, ctr, position) VALUES ($1,$2,$3,$4,$5,200,0.05,4)`,
        [site.id, day, `q${i}`, `https://${d}${p}`, 30 - i]);
    }
    for (const p of ['/blog/a', '/blog/b', '/blog/c', '/blog/d', '/privacy', ...ranking]) {
      await dbm.query(`INSERT INTO page_inventory (site_id, page, discovered_via, first_seen_at) VALUES ($1, $2, 'sitemap', now() - interval '60 days')`, [site.id, `https://${d}${p}`]);
    }
    const first = await syncZeroImpressionPages(site.id);
    assert.equal(first.invisible, 4);
    assert.equal(first.created, MAX_PER_SITE_PER_DAY);
    const recs = (await dbm.query(`SELECT * FROM recommendations WHERE site_id = $1 ORDER BY id`, [site.id])).rows;
    assert.equal(recs.length, 3);
    for (const r of recs) {
      assert.equal(r.recommendation_type, 'internal-links');
      assert.equal(r.risk_tier, 'safe');
      assert.match(r.page, /\/blog\/hit\d?$/, 'linked from a page in the same section');
      assert.match(r.params.mustLinkTo, /\/blog\/[abcd]$/);
    }
    assert.equal(new Set(recs.map((r) => r.page)).size, 3, 'each source page carries one open link fix');
    const second = await syncZeroImpressionPages(site.id);
    assert.equal(second.created, 1, 'only the one page not yet queued');
    assert.equal((await syncZeroImpressionPages(site.id)).created, 0, 'nothing is queued twice within 30 days');
  });
});
