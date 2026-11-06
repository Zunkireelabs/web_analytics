import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { recordSpend, getMonthSpendUsd, getMonthlyBudgetUsd, setMonthlyBudgetUsd, listSpendByEndpoint } from './provider-spend.js';

// Real DB (migration 231): the point is the real SQL — column names, the NUMERIC cast back to a float, the month
// boundary, and the site_id filter. Two sites are planted so a query that forgot site_id would charge one project's
// spend to the other and fail here.

const siteIds = [];
async function makeSite(label) {
  const stamp = `provider-spend-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('provider-spend.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM provider_spend_ledger WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM site_provider_budget WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('provider spend ledger (real DB)', () => {
  test('records a call and sums this month as a number', async () => {
    const siteId = await makeSite('sum');
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'keyword-demand', costUsd: 0.012, status: 'ok', httpStatus: 200 });
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'keyword-demand', costUsd: 0.008, status: 'ok', httpStatus: 200 });
    const spent = await getMonthSpendUsd(siteId, 'dataforseo');
    assert.equal(typeof spent, 'number');
    assert.ok(Math.abs(spent - 0.02) < 1e-9, `expected 0.02, got ${spent}`);
  });

  test('a null cost and a refused call add nothing to the total', async () => {
    const siteId = await makeSite('nulls');
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', costUsd: null, status: 'ok' });
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', status: 'budget_refused', detail: 'cap reached' });
    assert.equal(await getMonthSpendUsd(siteId, 'dataforseo'), 0);
  });

  test('spend is per site and per provider', async () => {
    const a = await makeSite('iso-a');
    const b = await makeSite('iso-b');
    await recordSpend(a, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', costUsd: 1.5, status: 'ok' });
    await recordSpend(b, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', costUsd: 0.25, status: 'ok' });
    await recordSpend(a, { provider: 'openai', endpoint: '/chat', job: 'j', costUsd: 9, status: 'ok' });
    assert.equal(await getMonthSpendUsd(a, 'dataforseo'), 1.5);
    assert.equal(await getMonthSpendUsd(b, 'dataforseo'), 0.25);
    assert.equal(await getMonthSpendUsd(b, 'openai'), 0);
  });

  test('last month does not count towards this month', async () => {
    const siteId = await makeSite('month');
    await query(
      `INSERT INTO provider_spend_ledger (site_id, provider, endpoint, job, cost_usd, status, created_at)
       VALUES ($1, 'dataforseo', '/v3/a', 'j', 5, 'ok', date_trunc('month', now()) - interval '2 days')`,
      [siteId]
    );
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', costUsd: 0.5, status: 'ok' });
    assert.equal(await getMonthSpendUsd(siteId, 'dataforseo'), 0.5);
  });

  test('budget is null until set, then read back as a number and updated in place', async () => {
    const siteId = await makeSite('budget');
    assert.equal(await getMonthlyBudgetUsd(siteId, 'dataforseo'), null);
    await setMonthlyBudgetUsd(siteId, 'dataforseo', 5);
    assert.equal(await getMonthlyBudgetUsd(siteId, 'dataforseo'), 5);
    await setMonthlyBudgetUsd(siteId, 'dataforseo', 2.5);
    assert.equal(await getMonthlyBudgetUsd(siteId, 'dataforseo'), 2.5);
    const { rows } = await query('SELECT count(*)::int AS n FROM site_provider_budget WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].n, 1);
  });

  test('a zero budget is a real cap, not "unset"', async () => {
    const siteId = await makeSite('zero');
    await setMonthlyBudgetUsd(siteId, 'dataforseo', 0);
    assert.equal(await getMonthlyBudgetUsd(siteId, 'dataforseo'), 0);
  });

  test('per-endpoint breakdown groups and orders by cost', async () => {
    const siteId = await makeSite('breakdown');
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/cheap', job: 'j', costUsd: 0.01, status: 'ok' });
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/dear', job: 'j', costUsd: 0.5, status: 'ok' });
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/dear', job: 'j', costUsd: 0.5, status: 'ok' });
    const rows = await listSpendByEndpoint(siteId);
    assert.equal(rows[0].endpoint, '/v3/dear');
    assert.equal(rows[0].calls, 2);
    assert.equal(rows[0].cost_usd, 1);
  });

  test('a long detail string is truncated rather than rejected', async () => {
    const siteId = await makeSite('detail');
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', status: 'failed', detail: 'x'.repeat(900) });
    const { rows } = await query('SELECT detail FROM provider_spend_ledger WHERE site_id = $1', [siteId]);
    assert.equal(rows[0].detail.length, 500);
  });

  test('deleting a site removes its ledger rows and budget', async () => {
    const siteId = await makeSite('cascade');
    await recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', costUsd: 1, status: 'ok' });
    await setMonthlyBudgetUsd(siteId, 'dataforseo', 1);
    await query('DELETE FROM sites WHERE id = $1', [siteId]);
    const ledger = await query('SELECT count(*)::int AS n FROM provider_spend_ledger WHERE site_id = $1', [siteId]);
    const budget = await query('SELECT count(*)::int AS n FROM site_provider_budget WHERE site_id = $1', [siteId]);
    assert.equal(ledger.rows[0].n, 0);
    assert.equal(budget.rows[0].n, 0);
  });

  test('an unknown status is refused by the table, not silently stored', async () => {
    const siteId = await makeSite('status');
    await assert.rejects(
      () => recordSpend(siteId, { provider: 'dataforseo', endpoint: '/v3/a', job: 'j', status: 'maybe' }),
      /provider_spend_ledger_status_check/
    );
  });
});
