// Reads EVERY fresh Data Analyst insight for a project, page by page.
//
// The plain endpoint returns only the newest 200 (a dashboard cap). On a noisy night the dimension-level insights fill all 200 and the
// page findings that can become fixes never reach the sync: measured on the production copy, 25 eligible findings for one project and
// 122 for another were invisible to it. This pages with limit/offset, bounded to the freshness window, until the service says there is
// no more. It never returns a partial list as if it were whole: a failed page throws, and hitting the safety ceiling throws too.
export const PAGE_SIZE = 500;
export const MAX_PAGES = 40; // 20,000 insights per project: far above any real night; a ceiling that fails loudly, not silently

export async function fetchAllFreshInsights(siteId, { call, sinceDays, pageSize = PAGE_SIZE, maxPages = MAX_PAGES }) {
  const all = []; const seen = new Set();
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const body = await call(`/clients/${siteId}/insights?limit=${pageSize}&offset=${offset}&since_days=${sinceDays}`);
    const items = Array.isArray(body) ? body : (body?.insights || []);
    for (const i of items) { const k = i?.id ?? JSON.stringify(i); if (!seen.has(k)) { seen.add(k); all.push(i); } }
    // An older service without paging answers with a plain list and no has_more: that is the whole answer it can give.
    if (!body || Array.isArray(body) || body.has_more === undefined) return { insights: all, pages: page + 1, paged: false };
    if (!body.has_more) return { insights: all, pages: page + 1, paged: true };
    offset = body.next_offset ?? offset + pageSize;
  }
  throw new Error(`analyst insight feed for project ${siteId} did not end after ${maxPages} pages; refusing to sync a partial list`);
}
