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
  login: (password) => req('/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => req('/logout', { method: 'POST' }),
  sites: () => req('/sites'),
  range: (site) => req(`/range?site=${site}`),
  docLink: (site) => req(`/doc-link?site=${site}`),
  dailyDocLink: (site) => req(`/daily-doc-link?site=${site}`),
  series: (site, start, end) => req(`/series?site=${site}&start=${start}&end=${end}`),
  day: (site, date) => req(`/day?site=${site}&date=${date}`),
  compare: (site, a, b) => req(`/compare?site=${site}&a=${a}&b=${b}`),
  compareRange: (site, aS, aE, bS, bE) => req(`/compare-range?site=${site}&a_start=${aS}&a_end=${aE}&b_start=${bS}&b_end=${bE}`),
  aiCompareRange: (site, aS, aE, bS, bE) => req('/ai-compare-range', { method: 'POST', body: JSON.stringify({ site, a_start: aS, a_end: aE, b_start: bS, b_end: bE }) }),
  aiSummary: (site, date) => req(`/ai-summary?site=${site}&date=${date}`),
  aiCompare: (site, a, b) => req('/ai-compare', { method: 'POST', body: JSON.stringify({ site, a, b }) }),
  aiAsk: (site, date, question) => req('/ai-ask', { method: 'POST', body: JSON.stringify({ site, date, question }) }),
  channels: (site, start, end) => req(`/channels?site=${site}&start=${start}&end=${end}`),
  device: (site, start, end) => req(`/device?site=${site}&start=${start}&end=${end}`),
  country: (site, start, end) => req(`/country?site=${site}&start=${start}&end=${end}`),
  movers: (site) => req(`/movers?site=${site}`),
};

// YYYY-MM-DD for `n` days before today (browser-local; fine for UI defaults).
export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
