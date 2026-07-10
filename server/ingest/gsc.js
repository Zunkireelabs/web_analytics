import { getSearchConsole } from '../auth/google.js';

// Fetch GSC Search Analytics for a single date, using `site`'s own Google
// credentials if it has a dedicated file (secrets/clients/<site.id>/), else
// the shared app-wide credentials.
// Returns { totals, queries, pages, queryPages } shaped for upsert.
// GSC finalizes data with a ~2-3 day lag, so callers fetch date = today-3 (and backfill).
export async function fetchGscForDate(site, date) {
  const gscProperty = site.gsc_property;
  const sc = await getSearchConsole(site);

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

  // query+page combined rows, so a single-click query can be traced to its exact
  // landing page (the single-dimension 'queries'/'pages' rows above share no key).
  // Also includes device + country for circumstantial context on that click.
  const queryPageRows = await queryApi(['query', 'page', 'device', 'country'], 250);
  const queryPages = queryPageRows.map((r) => ({
    query: r.keys?.[0] ?? '',
    page: r.keys?.[1] ?? '',
    device: r.keys?.[2] ?? '',
    country: r.keys?.[3] ?? '',
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));

  return { date, totals, queries, pages, devices, countries, queryPages };
}
