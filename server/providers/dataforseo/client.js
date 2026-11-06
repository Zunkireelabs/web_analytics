import { recordSpend, getMonthSpendUsd, getMonthlyBudgetUsd } from '../../store/provider-spend.js';

// The one place a paid DataForSEO call should go through: check the project's monthly budget, make the call, record the
// cost DataForSEO itself reported. Existing adapters are moved onto this one at a time; until then their behaviour is unchanged.
//
// Outcomes (never throws for a budget refusal, so a caller can skip cleanly):
//   { ok: true,  body, costUsd }                       call succeeded
//   { ok: false, reason: 'budget_refused', ... }        monthly cap reached, no call made
//   { ok: false, reason: 'failed', status, costUsd }    HTTP or task error; costUsd > 0 means DataForSEO still charged us
// Not-configured credentials are an error thrown to the caller, same as the adapters do today.

const PROVIDER = 'dataforseo';
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting = [];

async function withSlot(fn) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
  try { return await fn(); } finally { inFlight--; const next = waiting.shift(); if (next) next(); }
}

function authHeader(env) {
  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD } = env;
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set.');
  return 'Basic ' + Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
}

export async function dataforseoCall({
  siteId, job, endpoint, body, method = 'POST', timeoutMs = 20000,
  env = process.env,
  fetchImpl = fetch,
  deps = { recordSpend, getMonthSpendUsd, getMonthlyBudgetUsd },
}) {
  if (!siteId) throw new Error('dataforseoCall requires a siteId: every paid call belongs to a project.');
  if (!job) throw new Error('dataforseoCall requires a job name.');
  const authorization = authHeader(env);

  const budget = await deps.getMonthlyBudgetUsd(siteId, PROVIDER);
  if (budget != null) {
    const spent = await deps.getMonthSpendUsd(siteId, PROVIDER);
    if (spent >= budget) {
      await deps.recordSpend(siteId, { provider: PROVIDER, endpoint, job, status: 'budget_refused', detail: `spent ${spent.toFixed(4)} of ${budget} USD this month` });
      return { ok: false, reason: 'budget_refused', spentUsd: spent, budgetUsd: budget };
    }
  }

  const url = endpoint.startsWith('http') ? endpoint : `https://api.dataforseo.com${endpoint}`;
  let res;
  try {
    res = await withSlot(() => fetchImpl(url, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch (err) {
    await deps.recordSpend(siteId, { provider: PROVIDER, endpoint, job, status: 'failed', detail: err.message });
    return { ok: false, reason: 'failed', status: null, costUsd: 0, error: err.message };
  }

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body: handled as failed below */ }
  const costUsd = typeof json?.cost === 'number' ? json.cost : null;
  const task = json?.tasks?.[0];
  const taskOk = task && task.status_code === 20000;

  if (!res.ok || !json || !taskOk) {
    // DataForSEO can bill a task that then errors; record whatever cost it reported so the ledger matches the invoice.
    const charged = costUsd != null && costUsd > 0;
    const detail = task ? `${task.status_code} ${task.status_message}` : `HTTP ${res.status}`;
    await deps.recordSpend(siteId, { provider: PROVIDER, endpoint, job, costUsd, status: charged ? 'charged_failed' : 'failed', httpStatus: res.status, detail });
    return { ok: false, reason: 'failed', status: res.status, costUsd: costUsd ?? 0, error: detail };
  }

  await deps.recordSpend(siteId, { provider: PROVIDER, endpoint, job, costUsd, status: 'ok', httpStatus: res.status });
  return { ok: true, body: json, costUsd };
}
