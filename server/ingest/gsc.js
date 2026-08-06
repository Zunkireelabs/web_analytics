import { getSearchConsole } from '../auth/google.js';
import { knownDomain } from '../agents/lib/site-domain.js';

// A `sc-domain:` GSC property is domain-level — it returns EVERY subdomain
// Search Console has verified data for, which can include an entirely
// different, unrelated project (e.g. a client's app) hosted on a subdomain
// of the same root domain (confirmed as a real report: a court-portal
// client project on supreme-court.<domain> was showing up in this site's
// own SEO recommendations). A URL-prefix property (starting with
// "https://") is already scoped to one exact host and doesn't need this,
// but applying it there too is harmless — it can only ever match a subset
// of what that property already returns. Filtering at the Search Console
// API request itself (rather than after the fact, per-agent) means no
// consumer — this ingestion, any current agent, or any future one — can
// ever see a foreign subdomain's data, without each one having to
// remember to filter it out individually.
export function pageFilterGroups(domain) {
  if (!domain) return undefined; // no website_domain configured yet — same "pass through unfiltered" convention as filterOwnDomainPages
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: `^https?://(www\\.)?${escaped}([/?]|$)` }] }];
}

// Fetch GSC Search Analytics for a single date, using `site`'s own Google
// credentials if it has a dedicated file (secrets/clients/<site.id>/), else
// the shared app-wide credentials.
// Returns { totals, queries, pages, queryPages } shaped for upsert.
// GSC finalizes data with a ~2-3 day lag, so callers fetch date = today-3 (and backfill).
export async function fetchGscForDate(site, date) {
  const gscProperty = site.gsc_property;
  const sc = await getSearchConsole(site);
  const dimensionFilterGroups = pageFilterGroups(knownDomain(site));

  const queryApi = async (dimensions, rowLimit) => {
    const res = await sc.searchanalytics.query({
      siteUrl: gscProperty,
      requestBody: {
        startDate: date,
        endDate: date,
        dimensions,
        rowLimit,
        dataState: 'final',
        ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
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
