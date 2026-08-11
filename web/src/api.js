import { safeErrorMessage } from './lib/errors.js';

// Ceiling only, not a target duration — Run Full Analysis legitimately awaits
// ~19 parallel agents server-side, some LLM-heavy. Without this, a stalled
// request leaves the calling page's "Running…" state stuck forever with no
// way for the user to tell a hang from real, still-in-progress work.
const REQUEST_TIMEOUT_MS = 5 * 60_000;

// Thin fetch wrapper. Sends cookies (session) and throws on non-2xx.
//
// Every thrown Error's `.message` here is passed through safeErrorMessage
// (lib/errors.js) — the one place in the whole frontend this needs to
// happen, since ~90 components across this app just do
// `setError(e.message || '...')` with no sanitization of their own. The
// server already centralizes this at the source (server/lib/errors.js), so
// this is defense-in-depth: it also catches a raw browser/network-level
// failure (a fetch() TypeError, a devtools-visible connection error) that
// never went through the server's sanitizer at all.
async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${import.meta.env.BASE_URL}api${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...opts,
    });
  } catch (e) {
    if (e.name === 'TimeoutError') {
      throw new Error('Request timed out — it may still be running on the server.');
    }
    throw new Error(safeErrorMessage(e?.message, 'Could not reach the server — check your connection and try again.'));
  }
  if (res.status === 401) {
    // Lets App.jsx react to a session going invalid on ANY data call, not
    // just the ones that explicitly check for it — without this, mid-session
    // expiry just left individual pages showing local error states while
    // the URL/rendered-Login mismatch bug (see App.jsx) never got triggered.
    window.dispatchEvent(new Event('api:unauthorized'));
    throw new Error('UNAUTH');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = safeErrorMessage(body.error, 'Something went wrong — please try again.');
    // Most callers only ever read `.message` — this just makes any other
    // fields a specific error response includes (e.g. render-mode-uncertain's
    // confidence/suggestedMode) available to callers that need them, without
    // changing behavior for the ones that don't. Those fields are always
    // categorical/enum-shaped, never raw error text, so they don't need the
    // same sanitization `.message` just got.
    throw Object.assign(new Error(message), body, { status: res.status });
  }
  return res.json();
}

export const api = {
  me: () => req('/me'),
  login: (email, password) => req('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  // Public — no session required to call this (same as /login). Only ever
  // creates a pending signup_requests row, never a real account.
  submitSignupRequest: (body) => req('/signup-requests', { method: 'POST', body: JSON.stringify(body) }),
  // Public — no session required to call this (same as /login). Only ever
  // creates a contact_requests row: a lightweight lead, never an account.
  submitContactRequest: (body) => req('/contact-requests', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => req('/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) =>
    req('/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  verifyPassword: (password) => req('/verify-password', { method: 'POST', body: JSON.stringify({ password }) }),
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
  // siteId is only ever passed by an internal admin's Milestones picker
  // (web/src/pages/GrowthReport.jsx) to view another client's site — every
  // other caller (and every non-internal user) omits it and hits the plain
  // session-scoped route exactly as before.
  growthReport: (siteId) => (siteId ? req(`/internal/growth-report/${siteId}`) : req('/growth-report')),
  growthTargets: {
    set: (body) => req('/growth-targets', { method: 'POST', body: JSON.stringify(body) }),
    setBatch: (targets) => req('/growth-targets/batch', { method: 'POST', body: JSON.stringify({ targets }) }),
    history: (metric) => req(`/growth-targets/${metric}/history`),
  },
  runAiRecommendation: () => req('/growth-report/run-ai-recommendation', { method: 'POST' }),
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

  commonCrawlBacklinks: {
    summary: (domain) => req(`/commoncrawl-backlinks/summary?domain=${encodeURIComponent(domain)}`),
  },

  commandCenter: {
    get: () => req('/command-center'),
    refresh: (start, end) => req('/command-center/refresh', { method: 'POST', body: JSON.stringify({ start, end }) }),
    agenticStats: () => req('/command-center/agentic-stats'),
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
    setOauthPolicy: (id, oauthMaxPermissionLevel) => req(`/internal/clients/${id}/oauth-policy`, { method: 'POST', body: JSON.stringify({ oauthMaxPermissionLevel }) }),
    setVisibleFaqCap: (id, visibleFaqCap) => req(`/internal/clients/${id}/visible-faq-cap`, { method: 'POST', body: JSON.stringify({ visibleFaqCap }) }),
    recalculateFaqBaseline: (id) => req(`/internal/clients/${id}/recalculate-faq-baseline`, { method: 'POST' }),
    regenerateComponentTemplate: (id, actionType, pageUrl) => req(`/internal/clients/${id}/component-templates/${actionType}/regenerate`, { method: 'POST', body: JSON.stringify({ pageUrl }) }),
    confirmComponentTemplate: (id, actionType, template) => req(`/internal/clients/${id}/component-templates/${actionType}/confirm`, { method: 'POST', body: JSON.stringify({ template }) }),
    growthSummary: () => req('/internal/clients/growth-summary'),
    signupRequests: {
      list: () => req('/internal/signup-requests'),
      approve: (id) => req(`/internal/signup-requests/${id}/approve`, { method: 'POST' }),
      reject: (id) => req(`/internal/signup-requests/${id}/reject`, { method: 'POST' }),
    },
    // Tenant lifecycle (PLATFORM-ADMIN-DESIGN.md §D, §K Phase 3/3.5) — status
    // transitions only; hardDelete additionally requires typed-name confirmation.
    suspend: (id) => req(`/internal/tenants/${id}/suspend`, { method: 'POST' }),
    reactivate: (id) => req(`/internal/tenants/${id}/reactivate`, { method: 'POST' }),
    softDelete: (id) => req(`/internal/tenants/${id}/soft-delete`, { method: 'POST' }),
    hardDelete: (id, confirmName) => req(`/internal/tenants/${id}/hard-delete`, { method: 'POST', body: JSON.stringify({ confirmName }) }),
  },

  // Staff-only "Analyst" dashboard — thin passthrough to the standalone
  // data-analyst-agent/ Python service via server/routes/dataAnalyst.js
  // (which attaches the service's admin key server-side). Cross-client, same
  // gate as `clients` above.
  analyst: {
    dashboard: (clientId) => req(`/internal/analyst/dashboard/${clientId}`),
    series: (clientId, metricKey) => req(`/internal/analyst/dashboard/${clientId}/series/${metricKey}`),
    breakdown: (clientId, metricKey, dimensionType) =>
      req(`/internal/analyst/dashboard/${clientId}/breakdown/${metricKey}/${dimensionType}`),
    availableDimensions: (clientId, metricKey) =>
      req(`/internal/analyst/clients/${clientId}/metrics/${metricKey}/dimensions`),
    ask: (clientId, question) => req(`/internal/analyst/ask/${clientId}`, { method: 'POST', body: JSON.stringify({ question }) }),
    resolveRecommendation: (clientId, recommendationId) =>
      req(`/internal/analyst/clients/${clientId}/recommendations/${recommendationId}/resolve`, { method: 'POST' }),
    dismissRecommendation: (clientId, recommendationId) =>
      req(`/internal/analyst/clients/${clientId}/recommendations/${recommendationId}/dismiss`, { method: 'POST' }),
    recommendationSummary: (clientId, recommendationId) =>
      req(`/internal/analyst/clients/${clientId}/recommendations/${recommendationId}/summary`, { method: 'POST' }),
    investigationReport: (clientId, title, sections) =>
      req(`/internal/analyst/clients/${clientId}/insights/investigation-report`, {
        method: 'POST', body: JSON.stringify({ title, sections }),
      }),
    generateSeoDraft: (clientId, insight) =>
      req(`/internal/analyst/clients/${clientId}/insights/generate-draft`, {
        method: 'POST', body: JSON.stringify({ insight }),
      }),
    alerts: () => req('/internal/analyst/alerts'),
    // AI Analyst Workspace — Phase 2 intelligence engines.
    diagnostics: (clientId, metricKey) => req(`/internal/analyst/clients/${clientId}/diagnostics/${metricKey}`),
    correlations: (clientId) => req(`/internal/analyst/clients/${clientId}/correlations`),
    rootCause: (clientId, insightId) => req(`/internal/analyst/clients/${clientId}/root-cause/${insightId}`),
    effortEstimation: (clientId, recommendationId) =>
      req(`/internal/analyst/clients/${clientId}/effort-estimation/${recommendationId}`),
    timeToImpact: (clientId, recommendationId) =>
      req(`/internal/analyst/clients/${clientId}/time-to-impact/${recommendationId}`),
    opportunityScore: (clientId, recommendationId) =>
      req(`/internal/analyst/clients/${clientId}/opportunity-score/${recommendationId}`),
    recommendationRankings: (clientId) =>
      req(`/internal/analyst/clients/${clientId}/recommendation-rankings`),
    featureImportance: (clientId, targetMetricKey) =>
      req(`/internal/analyst/clients/${clientId}/feature-importance/${targetMetricKey}`),
    impactProjection: (clientId, body) =>
      req(`/internal/analyst/clients/${clientId}/impact-projection`, { method: 'POST', body: JSON.stringify(body) }),
    executiveSummary: (clientId) =>
      req(`/internal/analyst/dashboard/${clientId}/executive-summary`, { method: 'POST' }),
    getBusinessValues: (clientId) => req(`/internal/analyst/clients/${clientId}/business-values`),
    setBusinessValues: (clientId, body) =>
      req(`/internal/analyst/clients/${clientId}/business-values`, { method: 'PUT', body: JSON.stringify(body) }),
  },

  // Keyword Discovery (server/routes/keywords.js) — clusters/gaps/site-profile
  // produced by agents/clustering.py. gaps' status is pending_review/approved/
  // rejected end-to-end (gaps() returns it, updateGapStatus() takes it back),
  // matching server/store/data-analyst.js's own public vocabulary exactly.
  keywords: {
    clusters: (siteId, clusterType) =>
      req(`/internal/keywords/${siteId}/clusters${clusterType ? `?cluster_type=${clusterType}` : ''}`),
    gaps: (siteId, status) =>
      req(`/internal/keywords/${siteId}/gaps${status ? `?status=${status}` : ''}`),
    // A keyword the user typed on the Analyst page as a growth target — queued
    // as a normal pending gap, then approved through updateGapStatus like any
    // machine-found one.
    createGap: (siteId, topic) =>
      req(`/internal/keywords/${siteId}/gaps`, { method: 'POST', body: JSON.stringify({ topic }) }),
    updateGapStatus: (siteId, gapId, status) =>
      req(`/internal/keywords/${siteId}/gaps/${gapId}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    profile: (siteId) => req(`/internal/keywords/${siteId}/profile`),
    // Supplementary narrative (server/agents/keyword-narrative.js) — separate
    // from api.analyst.executiveSummary's Python pipeline.
    narrative: (siteId) => req(`/internal/keywords/${siteId}/narrative`),
    // AI-suggested section order (server/routes/keywords.js's GET .../layout) —
    // consumed by Analyst.jsx's loadAILayout, separate from api.keywords.narrative.
    layout: (siteId) => req(`/internal/keywords/${siteId}/layout`),
  },

  // Platform-wide user directory (PLATFORM-ADMIN-DESIGN.md §E, §K Phase 4) —
  // any tenant, any role including platform tiers. Distinct from `team`
  // below, which is scoped to the caller's own tenant.
  adminUsers: {
    list: () => req('/internal/users'),
    invite: (body) => req('/internal/users', { method: 'POST', body: JSON.stringify(body) }),
    updateRole: (id, role) => req(`/internal/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    disable: (id) => req(`/internal/users/${id}`, { method: 'DELETE' }),
  },

  // Own-tenant user management, backs Settings.jsx's Team tab — site_id is
  // always the caller's own session, server-derived, never sent from here.
  team: {
    list: () => req('/users'),
    invite: (body) => req('/users', { method: 'POST', body: JSON.stringify(body) }),
    updateRole: (id, role) => req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    disable: (id) => req(`/users/${id}`, { method: 'DELETE' }),
  },

  // Cross-tenant MCP token oversight (PLATFORM-ADMIN-DESIGN.md §F.6, §K
  // Phase 5) — metadata only, never a raw token value.
  mcpAdmin: {
    list: () => req('/internal/mcp-tokens'),
    revoke: (id) => req(`/internal/mcp-tokens/${id}/revoke`, { method: 'POST' }),
  },

  systemHealth: {
    get: () => req('/internal/system-health'),
  },

  opsCenter: {
    get: () => req('/internal/ops-center'),
  },

  auditLog: {
    list: (filters = {}) => req(`/internal/audit-log?${new URLSearchParams(filters)}`),
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
    reject: (id, reason) => req(`/action-center/drafts/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    approveDraft: (id, renderMode) => req(`/action-center/drafts/${id}/approve`, { method: 'POST', body: JSON.stringify({ renderMode }) }),
    implementDraft: (id) => req(`/action-center/drafts/${id}/implemented`, { method: 'POST' }),
    pushBranch: (id, renderMode) => req(`/action-center/drafts/${id}/push-branch`, { method: 'POST', body: JSON.stringify({ renderMode }) }),
    openPr: (id) => req(`/action-center/drafts/${id}/open-pr`, { method: 'POST' }),
    checkPrStatus: (id) => req(`/action-center/drafts/${id}/check-pr-status`, { method: 'POST' }),
    previewDraft: (id) => req(`/action-center/drafts/${id}/preview`),
    rollback: (id) => req(`/action-center/drafts/${id}/rollback`, { method: 'POST' }),
    executeSafeFixes: (limit) => req('/action-center/execute-safe-fixes', { method: 'POST', body: JSON.stringify({ limit }) }),
    approveAndShip: (recommendationId) => req(`/action-center/recommendations/${recommendationId}/approve-and-ship`, { method: 'POST' }),
    recheckRecommendation: (recommendationId) => req(`/action-center/recommendations/${recommendationId}/recheck`, { method: 'POST' }),
    getExecutionJob: (id) => req(`/action-center/execution-jobs/${id}`),

    todayExecutionStats: () => req('/action-center/execution-stats/today'),

  },

  siteAudit: {
    trigger: (maxPages) => req('/site-audit/run', { method: 'POST', body: JSON.stringify(maxPages ? { maxPages } : {}) }),
    list: () => req('/site-audit/runs'),
    get: (id) => req(`/site-audit/runs/${id}`),
    cancel: (id) => req(`/site-audit/runs/${id}/cancel`, { method: 'POST' }),
  },

  mcpTokens: {
    list: () => req('/mcp-tokens'),
    create: (label, permissionLevel) => req('/mcp-tokens', { method: 'POST', body: JSON.stringify({ label, permissionLevel }) }),
    revoke: (id) => req(`/mcp-tokens/${id}`, { method: 'DELETE' }),
  },

  // Backs the OAuth "Connect" consent screen (pages/OAuthAuthorize.jsx).
  // Deliberately no `permissionLevel`/tier field anywhere here — the server
  // derives it from this session's own site, never from what the browser
  // sends. See server/routes/oauth-consent.js.
  oauth: {
    authorizeInfo: (params) => req(`/oauth/authorize-info?${new URLSearchParams(params)}`),
    decide: (body) => req('/oauth/authorize/decision', { method: 'POST', body: JSON.stringify(body) }),
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
