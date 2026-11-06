// LAYOUT SURVEY — look at EVERY known page of a site, group the pages that are
// really built from the same template, and say which page represents each group.
//
// capture.js can only open a bounded number of pages in a browser, and a site
// can have hundreds. Picking which ones by URL shape is a guess (a /blog/ post
// may not look like the other posts; a flat slug may share a template with
// nothing). This does not guess: it fetches the served HTML of every page the
// platform knows (cheap, no browser, no model), reduces each to the set of CSS
// classes used in its main content, and groups pages whose class sets overlap.
// Pages that share a template overlap almost completely; a page that was
// redesigned does not, so it surfaces as its own group (an "outlier").
//
// Output is plain data. capture.js opens ONE sample per group in the browser;
// the group map (every page -> its group) is saved on the design profile so the
// agent can look up, for any page, which captured sample shows its design.
//
// Limit, stated plainly: this reads the HTML the server sends. A page whose
// markup is built only in the browser after load will look empty here; such a
// page is reported under `unreadable`, not silently merged into a group.

export const SIMILARITY_THRESHOLD = Number(process.env.DESIGN_AGENT_LAYOUT_SIMILARITY) || 0.6;
const MAX_SURVEY_PAGES = Number(process.env.DESIGN_AGENT_LAYOUT_SURVEY_MAX_PAGES) || 400;
const MIN_CLASSES = 8; // fewer distinct classes than this = nothing to compare (empty shell / redirect)

// Pages that are never a design to learn: tooling, auth, tests, old copies,
// thank-you pages. Surveying them would only create noise groups.
export const NOT_A_LAYOUT = /(^|\/)(admin|api|login|logout|signin|sign-in|auth|dashboard|preview|test|tests|staging|old|draft|thank-you|coming-soon|wp-admin)(\/|-|$)|-(admin|old|v\d+|test|preview|copy)(\/|$)|(old|test)-/i;

export function structuralSignature(html) {
  const main = html.match(/<main[\s\S]*<\/main>/i)?.[0] || html.replace(/<(header|footer|nav)[\s\S]*?<\/\1>/gi, '');
  const classes = new Set();
  for (const m of main.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  return classes;
}

export function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / ((a.size + b.size - inter) || 1);
}

// pages: [{ url, classes:Set }]. Greedy leader clustering, then the sample of
// each group is its most central member (highest total similarity to the rest),
// so one odd page that slipped in cannot become the representative.
export function clusterPages(pages, { threshold = SIMILARITY_THRESHOLD } = {}) {
  const groups = [];
  for (const page of pages) {
    let best = null; let bestSim = 0;
    for (const g of groups) {
      const sim = jaccard(page.classes, g.leader.classes);
      if (sim > bestSim) { bestSim = sim; best = g; }
    }
    if (best && bestSim >= threshold) best.members.push(page);
    else groups.push({ leader: page, members: [page] });
  }
  return groups
    .map((g) => {
      let sample = g.members[0];
      if (g.members.length > 2) {
        let top = -1;
        for (const m of g.members) {
          const score = g.members.reduce((acc, o) => acc + (o === m ? 0 : jaccard(m.classes, o.classes)), 0);
          if (score > top) { top = score; sample = m; }
        }
      }
      return { sample: sample.url, members: g.members.map((m) => m.url) };
    })
    .sort((a, b) => b.members.length - a.members.length)
    .map((g, i) => ({ id: `g${i + 1}`, ...g }));
}

async function defaultFetchHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; ZunkireeDesignSurvey/1.0)' }, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (type && !/html/i.test(type)) return null;
  return res.text();
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function surveyLayouts(urls, { fetchHtml = defaultFetchHtml, concurrency = 6, threshold = SIMILARITY_THRESHOLD, maxPages = MAX_SURVEY_PAGES } = {}) {
  const candidates = [...new Set(urls)].filter((u) => {
    try { return !NOT_A_LAYOUT.test(new URL(u).pathname); } catch { return false; }
  }).slice(0, maxPages);

  const unreachable = [];
  const unreadable = [];
  const pages = [];
  const results = await mapPool(candidates, concurrency, async (url) => {
    try { return { url, html: await fetchHtml(url) }; } catch { return { url, html: null }; }
  });
  for (const { url, html } of results) {
    if (!html) { unreachable.push(url); continue; }
    const classes = structuralSignature(html);
    if (classes.size < MIN_CLASSES) { unreadable.push(url); continue; }
    pages.push({ url, classes });
  }
  return {
    surveyedAt: new Date().toISOString(),
    threshold,
    pagesSurveyed: pages.length,
    groups: clusterPages(pages, { threshold }),
    unreachable,
    unreadable,
  };
}

// What gets stored on the design profile: paths only, so it stays small.
export function compactSurvey(survey) {
  if (!survey?.groups?.length) return null;
  const path = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  return {
    surveyedAt: survey.surveyedAt,
    similarityThreshold: survey.threshold,
    pagesSurveyed: survey.pagesSurveyed,
    groups: survey.groups.map((g) => ({ id: g.id, size: g.members.length, sample: path(g.sample), members: g.members.map(path) })),
    unreachable: (survey.unreachable || []).map(path),
    unreadable: (survey.unreadable || []).map(path),
  };
}
