import { getSearchConsole } from '../auth/google.js';
import { ownDomains, hostnameOf } from '../agents/lib/site-domain.js';

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
//
// `domains` is either a single hostname or the fuller ownDomains(site) set
// (e.g. a hero product legitimately hosted on its own subdomain, alongside
// the main site) — every entry gets its own alternation branch, so a page
// on ANY of them passes, while an unlisted subdomain still doesn't.
export function pageFilterGroups(domains) {
  const list = (Array.isArray(domains) ? domains : [domains]).filter(Boolean);
  if (!list.length) return undefined; // no website_domain configured yet — same "pass through unfiltered" convention as filterOwnDomainPages
  const alternation = list
    .map((d) => `(www\\.)?${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    .join('|');
  return [{ filters: [{ dimension: 'page', operator: 'includingRegex', expression: `^https?://(${alternation})([/?]|$)` }] }];
}

// Tripwire for the query-only dimension specifically — unlike page/
// queryPage rows, a query-only row has no page/URL on it at all, so it
// can never be hostname-checked the way queryPageRowsOwn above is. The
// dimensionFilterGroups page-filter already confirmed unreliable on one
// combined request (see fetchGscForDate) — there is no proof it is
// reliable here either, just no independent way to re-check it directly.
// The closest indirect check: a query's OWN total impressions (this
// unfiltered per-query request) should already be fully accounted for by
// that same query's impressions in queryPages (which IS hard-filtered to
// ownDomains). A query with meaningfully MORE unfiltered impressions than
// its filtered total suggests some of that volume came from a page
// outside ownDomains that this call's filter let through anyway — the
// same class of leak already found once. Tolerant of a real, benign gap:
// queryPages caps at 250 rows, so a long-tail query spread across many
// low-volume pages can legitimately be undercounted there without any
// leak — hence a ratio threshold, not exact equality, and a minimum
// impression floor so single-digit noise never fires this. (The queryPages
// cap is now GSC_QUERY_PAGE_ROW_LIMIT, raised from 250, which makes that
// benign gap rarer but not impossible — the tolerance still earns its keep.)
export function detectQueryDimensionLeakage(queries, queryPages, { minImpressions = 20, toleranceRatio = 1.5 } = {}) {
  const filteredImpressionsByQuery = new Map();
  for (const r of queryPages) {
    const key = r.query;
    filteredImpressionsByQuery.set(key, (filteredImpressionsByQuery.get(key) || 0) + Number(r.impressions || 0));
  }
  const suspicious = [];
  for (const q of queries) {
    const unfilteredImpressions = Number(q.impressions || 0);
    if (unfilteredImpressions < minImpressions) continue;
    const filteredImpressions = filteredImpressionsByQuery.get(q.dim_value) || 0;
    if (unfilteredImpressions > filteredImpressions * toleranceRatio) {
      suspicious.push({ query: q.dim_value, unfilteredImpressions, filteredImpressions });
    }
  }
  return suspicious;
}

// Env-overridable so a site with an unusually broad footprint can be widened
// without a deploy. Both are well inside GSC's 25,000-row per-call ceiling.
const GSC_TOP_N_ROW_LIMIT = Number(process.env.GSC_TOP_N_ROW_LIMIT) || 1000;
// The query+page combined request — the single most important one for the
// Analyst, since gsc_query_page is what page/query trend, decline and
// forecast work all read. At 250 this file's own leak-detector comment
// already acknowledged undercounting a long-tail query spread across many
// low-volume pages; that undercount was silently shaping every downstream
// page/query signal.
const GSC_QUERY_PAGE_ROW_LIMIT = Number(process.env.GSC_QUERY_PAGE_ROW_LIMIT) || 5000;

// Fetch GSC Search Analytics for a single date, using `site`'s own Google
// credentials if it has a dedicated file (secrets/clients/<site.id>/), else
// the shared app-wide credentials.
// Returns { totals, queries, pages, queryPages } shaped for upsert.
// GSC finalizes data with a ~2-3 day lag, so callers fetch date = today-3 (and backfill).
export async function fetchGscForDate(site, date) {
  const gscProperty = site.gsc_property;
  const sc = await getSearchConsole(site);
  const dimensionFilterGroups = pageFilterGroups(ownDomains(site));

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

  // Query/page depth is what the Analyst's long-tail visibility is made of.
  //
  // These were 25 — a DISPLAY cap inherited from the dashboard's top-N cards,
  // never an API or cost constraint. Verified before raising it:
  //   - Cost is unchanged. rowLimit does not add requests; GSC serves up to
  //     25,000 rows in this same single call, so the day still costs 6 calls.
  //   - The dashboard is unaffected. Every read applies its own LIMIT
  //     (store/read.js getBreakdown 10, getRangeTopQueries 5), so storing
  //     more rows changes storage only, never a rendered list.
  //   - Writes stay idempotent. gsc_breakdown is delete-then-reinsert per
  //     (site, date, dim_type), so a shrinking result set leaves no stale rows.
  //   - Storage is modest: ~1k rows/day/site worst case, and this site
  //     currently returns ~90 query+page rows a day in total.
  // Deliberately NOT unbounded: a cap still bounds a pathological day, and
  // device/country below keep their small caps because they ARE closed, short
  // vocabularies where 25 already covers the real set.
  const queries = mapRows(await queryApi(['query'], GSC_TOP_N_ROW_LIMIT));
  const pages = mapRows(await queryApi(['page'], GSC_TOP_N_ROW_LIMIT));
  const devices = mapRows(await queryApi(['device'], 10));   // DESKTOP / MOBILE / TABLET
  const countries = mapRows(await queryApi(['country'], 25)); // ISO-3 country codes

  // query+page combined rows, so a single-click query can be traced to its exact
  // landing page (the single-dimension 'queries'/'pages' rows above share no key).
  // Also includes device + country for circumstantial context on that click.
  const queryPageRows = await queryApi(['query', 'page', 'device', 'country'], GSC_QUERY_PAGE_ROW_LIMIT);
  const domains = ownDomains(site);
  // Real, observed gap: the API's own page-dimension regex filter above
  // (dimensionFilterGroups) does not reliably exclude a foreign subdomain
  // on THIS particular 4-dimension combined request, even though the
  // identical filter correctly excludes it on the single-dimension 'page'
  // query just above — confirmed live (supreme-court.<domain> rows still
  // came back here after the exact same filter). Never trust the upstream
  // API's filter alone for this one call: re-assert it in code so a
  // foreign subdomain's clicks can never reach gsc_query_page regardless
  // of whatever caused the API to not honor its own filter here.
  const queryPageRowsOwn = domains
    ? queryPageRows.filter((r) => domains.includes(hostnameOf(r.keys?.[1])))
    : queryPageRows;
  const queryPages = queryPageRowsOwn.map((r) => ({
    query: r.keys?.[0] ?? '',
    page: r.keys?.[1] ?? '',
    device: r.keys?.[2] ?? '',
    country: r.keys?.[3] ?? '',
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));

  if (domains) {
    const suspicious = detectQueryDimensionLeakage(queries, queryPages);
    if (suspicious.length) {
      console.warn(
        `[gsc] site ${site.id} ${date}: ${suspicious.length} quer${suspicious.length === 1 ? 'y' : 'ies'} may include impressions from outside ${domains.join(', ')} ` +
        `(query-only totals can't be hostname-checked directly — see detectQueryDimensionLeakage):`,
        suspicious.map((s) => `"${s.query}" (${s.unfilteredImpressions} unfiltered vs ${s.filteredImpressions} filtered)`).join('; ')
      );
    }
  }

  return { date, totals, queries, pages, devices, countries, queryPages };
}
