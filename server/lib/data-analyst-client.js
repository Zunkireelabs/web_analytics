import { safeMessage, describeHttpFailure } from './errors.js';

// Narrow, admin-key-injecting JSON client for the standalone
// data-analyst-agent/ Python service. Extracted from server/routes/dataAnalyst.js
// so a second caller (server/assistant/capabilities.js's ask_analyst_data,
// letting the platform-admin Assistant answer statistical/forecasting
// questions) doesn't reimplement the same fetch/error/admin-key logic.
const PYTHON_BASE_URL = process.env.DATA_ANALYST_AGENT_INTERNAL_URL || 'http://127.0.0.1:8000';

export async function callDataAnalystAgent(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, PYTHON_BASE_URL);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Admin-Key': process.env.DATA_ANALYST_AGENT_ADMIN_KEY || '',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const { message } = safeMessage('dataAnalystClient.call', e, 'Data Analyst Agent is unreachable right now');
    const err = new Error(message);
    err.status = 502;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || `Data Analyst Agent request ${describeHttpFailure(res.status)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Provisions (or re-provisions) this site's row in the Data Analyst's own
// `clients` table via PUT /admin/clients/by-site/{site_id}
// (data-analyst-agent/app/api/routes/admin_clients.py) — the HTTP equivalent of hand-running
// scripts/onboard_client.py, which is the manual step a connected tenant
// used to silently sit without: no forecasts, no anomalies, no
// forecast_risk recommendations, and nothing surfacing that as an error.
//
// `token` is optional. The Analyst can run entirely off the shared database
// (DataSource, data-analyst-agent/app/mcp_client/datasource.py) until a real
// MCP token exists for this site — call this once at onboarding with no
// token to get analysis started immediately, then call it again later with
// one once mcp-tokens issues it, which upgrades the client in place without
// losing its timezone/industry.
//
// Never throws on an unreachable/misconfigured Data Analyst service — the
// caller (onboarding) must not fail a repo/site connection because a
// separate internal service is down; it should log and let a later retry
// (or a manual re-run of this same call) catch it up.
export async function provisionAnalystClient(siteId, { name, timezone = 'UTC', token = null, permissionLevel = 'read_only', industry = null } = {}) {
  try {
    const result = await callDataAnalystAgent(`/admin/clients/by-site/${siteId}`, {
      method: 'PUT',
      body: { name, timezone, token, permission_level: permissionLevel, industry },
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
