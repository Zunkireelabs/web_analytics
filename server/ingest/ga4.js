import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { getGa4ClientOptions } from '../auth/google.js';

let client;
function ga4() {
  if (!client) client = new BetaAnalyticsDataClient(getGa4ClientOptions());
  return client;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v));

// Fetch GA4 metrics for a single date.
// Returns { totals, channels } shaped for upsert. GA4 is near-real-time (fetch date = today-1).
export async function fetchGa4ForDate(propertyId, date) {
  const property = `properties/${propertyId}`;

  // 1) Overall totals.
  const [totalsRes] = await ga4().runReport({
    property,
    dateRanges: [{ startDate: date, endDate: date }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'averageSessionDuration' },
      { name: 'conversions' },
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
  };

  // 2) Traffic by default channel group.
  const [chanRes] = await ga4().runReport({
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
    const [res] = await ga4().runReport({
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

  return { date, totals, channels, devices, countries };
}
