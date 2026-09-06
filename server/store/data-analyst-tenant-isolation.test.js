import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, pool } from '../db.js';
import {
  saveKeywordGaps, getKeywordGaps, appendKeywordGapEvidenceSnapshot,
  createProductCapability, getProductCapabilities,
} from './data-analyst.js';
import { relatesToCapability, buildProductTopicMap } from '../agents/lib/analyst-seo-mapping.js';

// Multi-tenant isolation for the keyword-growth pipeline: a keyword gap,
// product capability, or demand snapshot discovered for one site must never
// be visible to, or matched against, another site. Every read here already
// carries WHERE site_id = $1 in the SQL (data-analyst.js) — this proves that
// holds with two REAL, distinct sites and real rows, following the same
// real-DB tenant-isolation convention as competitor-policy.test.js and
// blog-outline.test.js, rather than trusting the SQL text by inspection
// alone.
//
// This also covers two of the explicit autonomous-discovery acceptance
// criteria: re-running discovery on an already-seen topic updates the
// existing row instead of duplicating it (migration 129's partial unique
// index), and a brand-new site with its own product_capabilities rows is
// matched generically by relatesToCapability/buildProductTopicMap with no
// per-tenant special-casing anywhere in the matcher.
describe('keyword-growth pipeline — tenant isolation', () => {
  let siteA, siteB;

  before(async () => {
    const a = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('Keyword Isolation Tenant A', 'sc-domain:tenant-a-keyword-isolation.example', 'test-ga4-kw-a') RETURNING *`
    );
    const b = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('Keyword Isolation Tenant B', 'sc-domain:tenant-b-keyword-isolation.example', 'test-ga4-kw-b') RETURNING *`
    );
    siteA = a.rows[0];
    siteB = b.rows[0];
  });

  after(async () => {
    await query('DELETE FROM keyword_gaps WHERE site_id = ANY($1)', [[siteA.id, siteB.id]]);
    await query('DELETE FROM product_capabilities WHERE site_id = ANY($1)', [[siteA.id, siteB.id]]);
    await query('DELETE FROM sites WHERE id = ANY($1)', [[siteA.id, siteB.id]]);
    await pool.end();
  });

  test("saveKeywordGaps writes only to the given site — Tenant A's discovery never creates a row under Tenant B", async () => {
    await saveKeywordGaps(siteA.id, [{ topic: 'ai booking engine for hotels', priority: 'high' }]);
    const gapsA = await getKeywordGaps(siteA.id, 'pending_review');
    const gapsB = await getKeywordGaps(siteB.id, 'pending_review');
    assert.ok(gapsA.some((g) => g.topic === 'ai booking engine for hotels'));
    assert.equal(gapsB.some((g) => g.topic === 'ai booking engine for hotels'), false, 'Tenant B must never see a gap discovered for Tenant A');
  });

  test('re-discovering the same topic in a LATER week updates the existing row (observation_count increments), never duplicates it', async () => {
    // observation_count counts distinct WEEKS a topic was re-observed, not raw
    // calls to saveKeywordGaps (migration 143). The explicit discoveryWeek
    // argument is what makes that testable without waiting a week; production
    // callers omit it and the current ISO-week Monday is computed in SQL.
    await saveKeywordGaps(siteA.id, [{ topic: 'sustainable packaging suppliers', priority: 'medium' }], 'internal_analysis', { discoveryWeek: '2026-08-31' });
    const beforeGaps = (await getKeywordGaps(siteA.id, 'pending_review')).filter((g) => g.topic === 'sustainable packaging suppliers');
    assert.equal(beforeGaps.length, 1);
    assert.equal(beforeGaps[0].observation_count, 1);

    // Next week's discovery pass finds the exact same topic again — a genuine
    // second observation, which is what qualifyAndShipContentGaps's `>= 2`
    // threshold is actually asking about.
    await saveKeywordGaps(siteA.id, [{ topic: 'sustainable packaging suppliers', priority: 'medium' }], 'internal_analysis', { discoveryWeek: '2026-09-07' });
    const afterGaps = (await getKeywordGaps(siteA.id, 'pending_review')).filter((g) => g.topic === 'sustainable packaging suppliers');
    assert.equal(afterGaps.length, 1, 'must update the same row, not insert a second one');
    assert.equal(afterGaps[0].id, beforeGaps[0].id);
    assert.equal(afterGaps[0].observation_count, 2, 'observation_count must increment on genuine re-discovery in a new week');
  });

  test('re-running discovery INSIDE the same week does not double-count the observation', async () => {
    // The nightly pipeline is not guaranteed to fire exactly once a day —
    // staging runs it twice (in-process APScheduler at 03:00 UTC and a host
    // crontab at 22:00 UTC, both calling the same run_nightly(), with no lock
    // between them). `observation_count = observation_count + 1` is the one
    // non-idempotent write in that pipeline, so the week gate has to hold
    // regardless of how many times a cycle runs.
    const week = '2026-09-14';
    await saveKeywordGaps(siteA.id, [{ topic: 'double run guard topic', priority: 'low' }], 'internal_analysis', { discoveryWeek: week });
    await saveKeywordGaps(siteA.id, [{ topic: 'double run guard topic', priority: 'low' }], 'internal_analysis', { discoveryWeek: week });
    await saveKeywordGaps(siteA.id, [{ topic: 'double run guard topic', priority: 'low' }], 'internal_analysis', { discoveryWeek: week });

    const rows = (await getKeywordGaps(siteA.id, 'pending_review')).filter((g) => g.topic === 'double run guard topic');
    assert.equal(rows.length, 1, 'repeated runs must never insert a duplicate row');
    assert.equal(rows[0].observation_count, 1, 'three runs inside one calendar week is still ONE observation');
  });

  test('an earlier-week re-sight arriving late never rewinds last_observed_week or double-counts', async () => {
    // A delayed/backfilled run must not be able to re-open an already-counted
    // week and let the next same-week run increment again.
    await saveKeywordGaps(siteA.id, [{ topic: 'late arrival topic', priority: 'low' }], 'internal_analysis', { discoveryWeek: '2026-09-21' });
    await saveKeywordGaps(siteA.id, [{ topic: 'late arrival topic', priority: 'low' }], 'internal_analysis', { discoveryWeek: '2026-09-07' });
    const rows = (await getKeywordGaps(siteA.id, 'pending_review')).filter((g) => g.topic === 'late arrival topic');
    assert.equal(rows[0].observation_count, 1, 'an out-of-order older week must not count as a new observation');
    // Asserted as a plain string: getKeywordGaps returns the week columns as
    // ::text so no timezone parsing can shift them a day (and thus a week).
    assert.equal(rows[0].last_observed_week, '2026-09-21', 'last_observed_week must never move backwards');
  });

  test('the same topic string discovered independently for two different sites creates two separate, isolated rows', async () => {
    await saveKeywordGaps(siteA.id, [{ topic: 'same topic both tenants', priority: 'low' }]);
    await saveKeywordGaps(siteB.id, [{ topic: 'same topic both tenants', priority: 'low' }]);
    const gapA = (await getKeywordGaps(siteA.id, 'pending_review')).find((g) => g.topic === 'same topic both tenants');
    const gapB = (await getKeywordGaps(siteB.id, 'pending_review')).find((g) => g.topic === 'same topic both tenants');
    assert.ok(gapA && gapB);
    assert.notEqual(gapA.id, gapB.id);
    assert.equal(gapA.observation_count, 1, 'Tenant B discovering the same topic string must never bump Tenant A\'s observation_count');
    assert.equal(gapB.observation_count, 1);
  });

  test("appending a demand/evidence snapshot to Tenant A's gap never touches Tenant B's gap of the same topic", async () => {
    const gapA = (await getKeywordGaps(siteA.id, 'pending_review')).find((g) => g.topic === 'same topic both tenants');
    const gapB = (await getKeywordGaps(siteB.id, 'pending_review')).find((g) => g.topic === 'same topic both tenants');
    await appendKeywordGapEvidenceSnapshot(siteA.id, gapA.id, { observed_at: new Date().toISOString(), impressions: 40, position: 6 });

    const refreshedA = (await getKeywordGaps(siteA.id, 'pending_review')).find((g) => g.id === gapA.id);
    const refreshedB = (await getKeywordGaps(siteB.id, 'pending_review')).find((g) => g.id === gapB.id);
    assert.equal(refreshedA.evidence_snapshots.length, 1);
    assert.equal(refreshedB.evidence_snapshots.length, 0, "Tenant B's demand evidence must be unaffected by Tenant A's snapshot");
  });

  test("getProductCapabilities never returns another tenant's capabilities", async () => {
    await createProductCapability(siteA.id, { name: 'AI Booking Engine', category: 'product', industries: ['hospitality'] });
    await createProductCapability(siteB.id, { name: 'Payroll Automation', category: 'product', industries: ['fintech'] });

    const capsA = await getProductCapabilities(siteA.id, 'verified');
    const capsB = await getProductCapabilities(siteB.id, 'verified');
    assert.ok(capsA.some((c) => c.name === 'AI Booking Engine'));
    assert.equal(capsA.some((c) => c.name === 'Payroll Automation'), false);
    assert.ok(capsB.some((c) => c.name === 'Payroll Automation'));
    assert.equal(capsB.some((c) => c.name === 'AI Booking Engine'), false);
  });

  test('a brand-new site with its own product_capabilities is matched generically by relatesToCapability — no hardcoded client logic', async () => {
    const c = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('Freshly Onboarded Client', 'sc-domain:fresh-client-keyword-isolation.example', 'test-ga4-kw-c') RETURNING *`
    );
    const siteC = c.rows[0];
    try {
      const capability = await createProductCapability(siteC.id, { name: 'Fleet Telematics Platform', category: 'product', industries: ['logistics'] });
      assert.equal(relatesToCapability('best fleet telematics platform for small carriers', capability), true);
      assert.equal(relatesToCapability('how to bake sourdough bread', capability), false);

      await saveKeywordGaps(siteC.id, [{ topic: 'fleet telematics for owner operators', priority: 'high' }]);
      const map = await buildProductTopicMap(siteC.id);
      const node = map.capabilities.find((n) => n.capability.name === 'Fleet Telematics Platform');
      assert.ok(node, 'a freshly-onboarded site must be mapped using only its own capability rows');
      assert.equal(node.visibility.openGapCount, 1);
    } finally {
      await query('DELETE FROM keyword_gaps WHERE site_id = $1', [siteC.id]);
      await query('DELETE FROM product_capabilities WHERE site_id = $1', [siteC.id]);
      await query('DELETE FROM sites WHERE id = $1', [siteC.id]);
    }
  });
});
