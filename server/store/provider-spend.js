import { query } from '../db.js';

// Persistence for the provider spend ledger (migration 231). Every function takes the siteId and puts it in the WHERE
// clause: nothing here can read or write another project's rows.

export async function recordSpend(siteId, { provider, endpoint, job, costUsd = null, status, httpStatus = null, detail = null }) {
  await query(
    `INSERT INTO provider_spend_ledger (site_id, provider, endpoint, job, cost_usd, status, http_status, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [siteId, provider, endpoint, job, costUsd, status, httpStatus, detail ? String(detail).slice(0, 500) : null]
  );
}

// Money spent so far this calendar month (UTC) on one provider for one project. Only rows that cost something count.
export async function getMonthSpendUsd(siteId, provider) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS spent
       FROM provider_spend_ledger
      WHERE site_id = $1 AND provider = $2
        AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [siteId, provider]
  );
  return rows[0]?.spent ?? 0;
}

// null = no cap set for this project (calls are not limited).
export async function getMonthlyBudgetUsd(siteId, provider) {
  const { rows } = await query(
    'SELECT monthly_usd::float AS monthly_usd FROM site_provider_budget WHERE site_id = $1 AND provider = $2',
    [siteId, provider]
  );
  return rows[0] ? rows[0].monthly_usd : null;
}

export async function setMonthlyBudgetUsd(siteId, provider, monthlyUsd) {
  await query(
    `INSERT INTO site_provider_budget (site_id, provider, monthly_usd) VALUES ($1, $2, $3)
     ON CONFLICT (site_id, provider) DO UPDATE SET monthly_usd = EXCLUDED.monthly_usd, updated_at = now()`,
    [siteId, provider, monthlyUsd]
  );
}

export async function listSpendByEndpoint(siteId, { days = 30 } = {}) {
  const { rows } = await query(
    `SELECT provider, endpoint, job, COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0)::float AS cost_usd
       FROM provider_spend_ledger
      WHERE site_id = $1 AND created_at >= now() - ($2::int * interval '1 day')
      GROUP BY provider, endpoint, job
      ORDER BY cost_usd DESC`,
    [siteId, Math.min(Math.max(Number(days) || 30, 1), 366)]
  );
  return rows;
}
