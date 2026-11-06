import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import {
  deriveOpportunityLifecycle, reconcileOpportunityLifecycles,
  listUncountedVerifiedOutcomes, markOutcomeCounted,
} from './opportunity-lifecycle.js';
import { saveCompetitorOpportunities, listCompetitorOpportunities } from './competitor-opportunities.js';

// Real DB (migrations 234/235). The whole point of this module is four joins across drafts, deployments and
// fix_impact, so fakes would prove nothing. Two sites share a PR number on purpose: a join that forgot site_id would
// attach one project's deployment to another project's draft and report work as live that never shipped.

const siteIds = [];
async function makeSite(label) {
  const stamp = `opp-lifecycle-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('opportunity-lifecycle.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

async function makeOpportunity(siteId, topic = 'teeth whitening cost') {
  await saveCompetitorOpportunities(siteId, [{
    keyword: topic, reason: 'rivals rank', score: 0.7, opportunityType: 'improve_page',
    searchVolume: 400, keywordDifficulty: 30, searchIntent: 'commercial',
    bestCompetitorPosition: 3, contentPlan: 'track', locationCode: 2524, languageCode: 'en',
    evidence: { competitors: [{ domain: 'rival.com', position: 3 }] },
  }]);
  const [gap] = await listCompetitorOpportunities(siteId);
  return gap;
}

async function makeDraft(siteId, gapId, over = {}) {
  const { rows } = await query(
    `INSERT INTO drafts (site_id, action_type, source, input, content, status, finding_id, pr_number, pr_state, implemented_at)
     VALUES ($1, 'content', 'analyst-keyword-gap', '{}'::jsonb, '{}'::jsonb, $2, $3, $4, $5, $6) RETURNING id`,
    [siteId, over.status || 'draft', `keyword-gap:${gapId}`, over.prNumber ?? null, over.prState ?? null, over.implementedAt ?? null]
  );
  return rows[0].id;
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM fix_impact WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM deployments WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM drafts WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM keyword_gaps WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM opportunity_type_outcomes WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('opportunity lifecycle derived from real records', () => {
  test('an opportunity with nothing shipped stays discovered', async () => {
    const siteId = await makeSite('discovered');
    await makeOpportunity(siteId);
    const [row] = await deriveOpportunityLifecycle(siteId);
    assert.equal(row.derivedState, 'discovered');
  });

  test('a draft makes it drafted — which is not a result', async () => {
    const siteId = await makeSite('drafted');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id);
    const [row] = await deriveOpportunityLifecycle(siteId);
    assert.equal(row.derivedState, 'drafted');
  });

  test('an OPEN pull request is still only drafted', async () => {
    const siteId = await makeSite('open-pr');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id, { status: 'approved', prNumber: 101, prState: 'open' });
    const [row] = await deriveOpportunityLifecycle(siteId);
    assert.equal(row.derivedState, 'drafted');
  });

  test('a merged pull request is merged, but not deployed', async () => {
    const siteId = await makeSite('merged');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id, { prNumber: 102, prState: 'merged' });
    const [row] = await deriveOpportunityLifecycle(siteId);
    assert.equal(row.derivedState, 'merged');
  });

  test('an undetected deployment does not count as deployed', async () => {
    const siteId = await makeSite('failed-deploy');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id, { prNumber: 103, prState: 'merged' });
    await query(
      `INSERT INTO deployments (site_id, commit_sha, pr_number, status, deployed_at) VALUES ($1, 'abc123', 103, 'not-detected', now())`,
      [siteId]
    );
    const [row] = await deriveOpportunityLifecycle(siteId);
    assert.equal(row.derivedState, 'merged');
  });

  test('a successful deployment is deployed, but still not a measured result', async () => {
    const siteId = await makeSite('deployed');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id, { prNumber: 104, prState: 'merged' });
    await query(
      `INSERT INTO deployments (site_id, commit_sha, pr_number, status, deployed_at) VALUES ($1, 'def456', 104, 'deployed', now())`,
      [siteId]
    );
    const [row] = await deriveOpportunityLifecycle(siteId);
    assert.equal(row.derivedState, 'deployed');
  });

  test('only a measured impact window makes it verified', async () => {
    const siteId = await makeSite('verified');
    const gap = await makeOpportunity(siteId);
    const draftId = await makeDraft(siteId, gap.id, { prNumber: 105, prState: 'merged' });
    await query(
      `INSERT INTO deployments (site_id, commit_sha, pr_number, status, deployed_at) VALUES ($1, 'aaa111', 105, 'deployed', now())`,
      [siteId]
    );
    // Pending measurement: still only deployed.
    await query(
      `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status)
       VALUES ($1, $2, 'https://ours.com/whitening', 'expand-content', now(), now(), 'pending')`,
      [siteId, draftId]
    );
    assert.equal((await deriveOpportunityLifecycle(siteId))[0].derivedState, 'deployed');

    await query(
      `UPDATE fix_impact SET status = 'measured', measured_at = now(),
              before_window = '{"clicks":100}'::jsonb, delta = '{"clicks":40}'::jsonb
        WHERE site_id = $1`,
      [siteId]
    );
    assert.equal((await deriveOpportunityLifecycle(siteId))[0].derivedState, 'verified');
  });

  test('one project\'s deployment never completes another project\'s work', async () => {
    const a = await makeSite('cross-a');
    const b = await makeSite('cross-b');
    const gapA = await makeOpportunity(a);
    await makeDraft(a, gapA.id, { prNumber: 999, prState: 'open' });
    // Same PR number, different project: must not be picked up by project A.
    await query(
      `INSERT INTO deployments (site_id, commit_sha, pr_number, status, deployed_at) VALUES ($1, 'bbb222', 999, 'deployed', now())`,
      [b]
    );
    assert.equal((await deriveOpportunityLifecycle(a))[0].derivedState, 'drafted');
  });

  test('a gap from another source is not treated as a competitor opportunity', async () => {
    const siteId = await makeSite('othersource');
    await query(
      `INSERT INTO keyword_gaps (site_id, topic, priority, status, source) VALUES ($1, 'unrelated topic', 'medium', 'pending_review', 'claude_research')`,
      [siteId]
    );
    assert.deepEqual(await deriveOpportunityLifecycle(siteId), []);
  });
});

describe('reconciling stored state', () => {
  test('it advances the stored state to what really happened', async () => {
    const siteId = await makeSite('reconcile');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id, { prNumber: 106, prState: 'merged' });
    const out = await reconcileOpportunityLifecycles(siteId);
    assert.deepEqual(out.advanced.map((a) => [a.from, a.to]), [['discovered', 'merged']]);
    assert.equal((await listCompetitorOpportunities(siteId))[0].lifecycle_state, 'merged');
  });

  test('running it twice changes nothing the second time', async () => {
    const siteId = await makeSite('idempotent');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id, { prNumber: 107, prState: 'merged' });
    await reconcileOpportunityLifecycles(siteId);
    const second = await reconcileOpportunityLifecycles(siteId);
    assert.deepEqual(second.advanced, []);
  });

  test('it never walks a verified outcome backwards, even if the draft disappears', async () => {
    const siteId = await makeSite('noregress');
    const gap = await makeOpportunity(siteId);
    const draftId = await makeDraft(siteId, gap.id, { prNumber: 108, prState: 'merged' });
    await query(
      `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status, measured_at, before_window, delta)
       VALUES ($1, $2, 'https://ours.com/p', 'expand-content', now(), now(), 'measured', now(), '{"clicks":10}'::jsonb, '{"clicks":5}'::jsonb)`,
      [siteId, draftId]
    );
    await reconcileOpportunityLifecycles(siteId);
    assert.equal((await listCompetitorOpportunities(siteId))[0].lifecycle_state, 'verified');

    await query('DELETE FROM fix_impact WHERE site_id = $1', [siteId]);
    await query('DELETE FROM drafts WHERE site_id = $1', [siteId]);
    await reconcileOpportunityLifecycles(siteId);
    assert.equal((await listCompetitorOpportunities(siteId))[0].lifecycle_state, 'verified');
  });
});

describe('counting a verified outcome exactly once', () => {
  async function verifiedSite(label) {
    const siteId = await makeSite(label);
    const gap = await makeOpportunity(siteId);
    const draftId = await makeDraft(siteId, gap.id, { prNumber: 200, prState: 'merged' });
    await query(
      `INSERT INTO fix_impact (site_id, draft_id, page_url, generator_id, merged_at, measure_after, status, measured_at, before_window, delta)
       VALUES ($1, $2, 'https://ours.com/p', 'expand-content', now(), now(), 'measured', now(), '{"clicks":100}'::jsonb, '{"clicks":40}'::jsonb)`,
      [siteId, draftId]
    );
    await reconcileOpportunityLifecycles(siteId);
    return { siteId, gapId: gap.id };
  }

  test('a verified outcome is listed with the measurement needed to judge it', async () => {
    const { siteId } = await verifiedSite('uncounted');
    const [row] = await listUncountedVerifiedOutcomes(siteId);
    assert.equal(row.opportunity_type, 'improve_page');
    assert.equal(row.delta.clicks, 40);
    assert.equal(row.before_window.clicks, 100);
  });

  test('once counted it is never listed again', async () => {
    const { siteId, gapId } = await verifiedSite('counted');
    assert.equal(await markOutcomeCounted(siteId, gapId), true);
    assert.deepEqual(await listUncountedVerifiedOutcomes(siteId), []);
    assert.equal(await markOutcomeCounted(siteId, gapId), false, 'a second claim must fail');
  });

  test('an unmeasured or undeployed opportunity is never listed', async () => {
    const siteId = await makeSite('notready');
    const gap = await makeOpportunity(siteId);
    await makeDraft(siteId, gap.id, { prNumber: 201, prState: 'merged' });
    await reconcileOpportunityLifecycles(siteId);
    assert.deepEqual(await listUncountedVerifiedOutcomes(siteId), []);
  });

  test('one project cannot claim another project\'s outcome', async () => {
    const { gapId } = await verifiedSite('claim-a');
    const other = await makeSite('claim-b');
    assert.equal(await markOutcomeCounted(other, gapId), false);
  });
});
