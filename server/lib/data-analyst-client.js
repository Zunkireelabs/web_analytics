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
