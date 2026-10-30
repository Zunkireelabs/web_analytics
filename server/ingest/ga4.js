import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { getGa4ClientOptionsAsync } from '../auth/google.js';

// One cached client per distinct credential set, keyed by site id — a single
// shared singleton would silently reuse the wrong client's credentials for
// other sites once any site has its own dedicated Google credentials file.
const clients = new Map();
// A project that connects (or disconnects) its own Google account changes which credential
// this must use, so the cached client is dropped by forgetGa4Client below.
const GA4_TIMEOUT_MS = Number(process.env.GOOGLE_API_TIMEOUT_MS) || 60_000;
async function ga4(site) {
  const key = site?.id ?? '__shared__';
  if (!clients.has(key)) {
    const client = new BetaAnalyticsDataClient(await getGa4ClientOptionsAsync(site));
    // Analytics Data calls go through gRPC, not googleapis, so they need their own time limit.
    const run = client.runReport.bind(client);
    client.runReport = (request, options, callback) => (typeof options === 'function'
      ? run(request, { timeout: GA4_TIMEOUT_MS }, options)
      : run(request, { timeout: GA4_TIMEOUT_MS, ...(options || {}) }, callback));
    clients.set(key, client);
  }
  return clients.get(key);
}
export function forgetGa4Client(siteId) { clients.delete(siteId); }

const num = (v) => (v == null || v === '' ? 0 : Number(v));

// Fetch GA4 metrics for a single date, using `site`'s own Google credentials
// if it has a dedicated file (secrets/clients/<site.id>/), else the shared
// app-wide credentials.
// Returns { totals, channels } shaped for upsert. GA4 is near-real-time (fetch date = today-1).
export async function fetchGa4ForDate(site, date) {
  const property = `properties/${site.ga4_property_id}`;

  // 1) Overall totals.
  const [totalsRes] = await (await ga4(site)).runReport({
    property,
    dateRanges: [{ startDate: date, endDate: date }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'averageSessionDuration' },
      { name: 'conversions' },
      { name: 'bounceRate' },
    ],
  });

  const row = totalsRes.rows?.[0]?.metricValues || [];
  const totals = {
    users: num(row[0]?.value),
    new_users: num(row[1]?.value),
    sessions: num(row[2]?.value),
    engaged_sessions: num(row[3]?.value),
    avg_engagement_time: num(row[4]?.value),
    conversions: num(row[5]?.value),
    bounce_rate: num(row[6]?.value),
  };

  // 2) Traffic by default channel group.
  const [chanRes] = await (await ga4(site)).runReport({
    property,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
  });

  const channels = (chanRes.rows || []).map((r) => ({
    channel: r.dimensionValues?.[0]?.value || '(other)',
    sessions: num(r.metricValues?.[0]?.value),
    users: num(r.metricValues?.[1]?.value),
  }));

  // 3) Breakdown by device category and by country (sessions + users).
  const breakdown = async (dimName) => {
    const [res] = await (await ga4(site)).runReport({
      property,
      dateRanges: [{ startDate: date, endDate: date }],
      dimensions: [{ name: dimName }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      limit: 25,
    });
    return (res.rows || []).map((r) => ({
      dim_value: r.dimensionValues?.[0]?.value || '(other)',
      sessions: num(r.metricValues?.[0]?.value),
      users: num(r.metricValues?.[1]?.value),
    }));
  };

  const devices = await breakdown('deviceCategory'); // desktop / mobile / tablet
  const countries = await breakdown('country');
  const cities = await breakdown('city');
  const languages = await breakdown('language'); // e.g. "English", "French"
  const browsers = await breakdown('browser'); // e.g. "Chrome", "Safari"
  const sourceMediums = await breakdown('sessionSourceMedium'); // e.g. "google / organic"

  return { date, totals, channels, devices, countries, cities, languages, browsers, sourceMediums };
}
