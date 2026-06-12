import { getSearchConsole } from '../auth/google.js';

// Fetch GSC Search Analytics for a single date.
// Returns { totals, queries, pages } shaped for upsert.
// GSC finalizes data with a ~2-3 day lag, so callers fetch date = today-3 (and backfill).
export async function fetchGscForDate(gscProperty, date) {
  const sc = await getSearchConsole();

  const queryApi = async (dimensions, rowLimit) => {
    const res = await sc.searchanalytics.query({
      siteUrl: gscProperty,
      requestBody: {
        startDate: date,
        endDate: date,
        dimensions,
        rowLimit,
        dataState: 'final',
      },
    });
    return res.data.rows || [];
  };

  // Totals: no dimensions → at most one aggregate row.
  const totalRows = await queryApi([], 1);
  const t = totalRows[0];
  const totals = t
    ? { clicks: t.clicks ?? 0, impressions: t.impressions ?? 0, ctr: t.ctr ?? 0, position: t.position ?? 0 }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  const mapRows = (rows) =>
    rows.map((r) => ({
      dim_value: r.keys?.[0] ?? '',
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));

  const queries = mapRows(await queryApi(['query'], 25));
  const pages = mapRows(await queryApi(['page'], 25));
  const devices = mapRows(await queryApi(['device'], 10));   // DESKTOP / MOBILE / TABLET
  const countries = mapRows(await queryApi(['country'], 25)); // ISO-3 country codes

  return { date, totals, queries, pages, devices, countries };
}
