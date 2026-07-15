// Thin fetch wrapper. Sends cookies (session) and throws on non-2xx.
async function req(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) throw new Error('UNAUTH');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  me: () => req('/me'),
  login: (email, password) => req('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  // Public — no session required to call this (same as /login). Only ever
  // creates a pending signup_requests row, never a real account.
  submitSignupRequest: (body) => req('/signup-requests', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => req('/logout', { method: 'POST' }),
  sites: () => req('/sites'),
  agents: () => req('/agents'),
  agentsStatus: () => req('/agents/status'),
  agentsActivity: (limit = 12) => req(`/agents/activity?limit=${limit}`),
  runAgent: (id, start, end, params) => req(`/agents/${id}/run`, { method: 'POST', body: JSON.stringify({ start, end, params }) }),
  agentRuns: (id, limit = 10) => req(`/agents/${id}/runs?limit=${limit}`),
  range: (site) => req(`/range?site=${site}`),
  reportSummary: (site, period) => req(`/report-summary?site=${site}&period=${period}`),
  reportInsights: (site) => req(`/report-insights?site=${site}`),
  series: (site, start, end) => req(`/series?site=${site}&start=${start}&end=${end}`),
  growthReport: () => req('/growth-report'),
  compare: (site, a, b) => req(`/compare?site=${site}&a=${a}&b=${b}`),
  compareRange: (site, aS, aE, bS, bE) => req(`/compare-range?site=${site}&a_start=${aS}&a_end=${aE}&b_start=${bS}&b_end=${bE}`),
  channels: (site, start, end) => req(`/channels?site=${site}&start=${start}&end=${end}`),
  breakdownRange: (site, start, end, dim, limit = 10) => req(`/breakdown-range?site=${site}&start=${start}&end=${end}&dim=${dim}&limit=${limit}`),
  device: (site, start, end) => req(`/device?site=${site}&start=${start}&end=${end}`),
  country: (site, start, end) => req(`/country?site=${site}&start=${start}&end=${end}`),
  movers: (site, start, end) => req(`/movers?site=${site}${start && end ? `&start=${start}&end=${end}` : ''}`),
  translate: (q) => req(`/translate?query=${encodeURIComponent(q)}`),

  copilot: {
    ask: (conversationId, message) => req('/copilot/ask', { method: 'POST', body: JSON.stringify({ conversationId, message }) }),
    conversations: () => req('/copilot/conversations'),
    messages: (conversationId) => req(`/copilot/conversations/${conversationId}/messages`),
  },

  watchlist: {
    list: (status) => req(`/watchlist${status ? `?status=${status}` : ''}`),
    setStatus: (id, status) => req(`/watchlist/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  },

  commandCenter: {
    get: () => req('/command-center'),
    refresh: (start, end) => req('/command-center/refresh', { method: 'POST', body: JSON.stringify({ start, end }) }),
  },

  notifications: {
    list: () => req('/notifications'),
    markRead: (id) => req(`/notifications/${id}/read`, { method: 'POST' }),
    markAllRead: () => req('/notifications/read-all', { method: 'POST' }),
  },

  integrations: {
    health: () => req('/integrations/health'),
    check: (id) => req(`/integrations/${id}/check`, { method: 'POST' }),
  },

  clients: {
    list: () => req('/internal/clients'),
    create: (body) => req('/internal/clients', { method: 'POST', body: JSON.stringify(body) }),
    connect: (id, body) => req(`/internal/clients/${id}/connect`, { method: 'POST', body: JSON.stringify(body) }),
    connectRepo: (id, body) => req(`/internal/clients/${id}/connect-repo`, { method: 'POST', body: JSON.stringify(body) }),
    retryBaseline: (id) => req(`/internal/clients/${id}/retry-baseline`, { method: 'POST' }),
    signupRequests: {
      list: () => req('/internal/signup-requests'),
      approve: (id) => req(`/internal/signup-requests/${id}/approve`, { method: 'POST' }),
      reject: (id) => req(`/internal/signup-requests/${id}/reject`, { method: 'POST' }),
    },
  },

  actionCenter: {
    recommendations: () => req('/action-center/recommendations'),
    refresh: (start, end) => req('/action-center/recommendations/refresh', { method: 'POST', body: JSON.stringify({ start, end }) }),
    generators: () => req('/action-center/generators'),
    generate: (generatorId, params, source, findingId) => req('/action-center/generate', { method: 'POST', body: JSON.stringify({ generatorId, params, source, findingId }) }),
    drafts: (filters = {}) => req(`/action-center/drafts?${new URLSearchParams(filters)}`),
    draft: (id) => req(`/action-center/drafts/${id}`),
    saveDraft: (id, content) => req(`/action-center/drafts/${id}`, { method: 'PUT', body: JSON.stringify({ content }) }),
    deleteDraft: (id) => req(`/action-center/drafts/${id}`, { method: 'DELETE' }),
    submitDraft: (id) => req(`/action-center/drafts/${id}/submit`, { method: 'POST' }),
    approveDraft: (id) => req(`/action-center/drafts/${id}/approve`, { method: 'POST' }),
    implementDraft: (id) => req(`/action-center/drafts/${id}/implemented`, { method: 'POST' }),
    pushBranch: (id) => req(`/action-center/drafts/${id}/push-branch`, { method: 'POST' }),
    mergeToStage: (id) => req(`/action-center/drafts/${id}/merge-to-stage`, { method: 'POST' }),
    previewDraft: (id) => req(`/action-center/drafts/${id}/preview`),
  },
};

// YYYY-MM-DD for `n` days before today (browser-local; fine for UI defaults).
export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Shortens a full page URL down to just its path, e.g.
// "https://zunkireelabs.com/services/consulting" -> "/services/consulting" —
// which page a finding/action is actually about is the single most useful
// piece of context on a card face (it's what tells two otherwise-identical
// "Add an FAQ section" cards apart), and nobody needs the domain repeated
// on every card of a single-site dashboard. Falls back to the raw value
// (or null) if it isn't a parseable URL.
export function pagePathFor(url) {
  if (!url) return null;
  try { return new URL(url).pathname || '/'; } catch { return url; }
}

// Compact "Xm/Xh/Xd ago" for a timestamp — shared by any page showing
// freshness of a persisted run (Action Center, AI Command Center).
export function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
