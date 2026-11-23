// SITE AREAS: one project, one repo, one domain, but parts of the site that need different SEO work.
// Real case: zennly.io serves a Next.js marketplace at "/" and an Eleventy business site under "/businesses", both from the same repo,
// with different page files, layouts, design and allowed fixes.
//
// Declared in url_file_map.areas (absent for every existing site, and then nothing in this file changes any behaviour):
//   areas: [
//     { name: "business",    include: ["/businesses"], override: { mounts, pages, patterns, defaults, siteRoot, newContentTargets, notApplicable, renderCapabilities } },
//     { name: "marketplace", include: [],              exclude: ["/businesses"], override: { ... } }   // empty include = the rest of the domain
//   ]
//
// siteForUrl(site, url) returns a COPY of the site whose url_file_map is the matching area's settings laid over the shared ones, so every
// existing reader (about 200 read url_file_map.siteRoot alone) works on the right area without knowing areas exist. The copy is a VIEW: it
// carries a marker and must never be saved back (db.js refuses, see AREA_VIEW), because that would overwrite the real map with one area.

export const AREA_VIEW = Symbol.for('superrank.areaView');

const WHOLE_REPLACE = ['pages', 'patterns', 'defaults', 'mounts', 'otherApps', 'newContentTargets', 'notApplicable', 'newContentNotApplicable', 'renderCapabilities'];
const MERGED_ONE_LEVEL = ['siteRoot'];

const norm = (p) => { const s = String(p || '').trim(); return s.length > 1 ? s.replace(/\/+$/, '') : s; };
function pathOf(url) { try { return new URL(url).pathname || '/'; } catch { return String(url || '') || '/'; } }
/** A prefix matches on a path-segment boundary: "/businesses" covers /businesses and /businesses/x, never /businessesfoo. "/" covers everything. */
function covers(prefix, path) {
  const p = norm(prefix); const q = norm(path);
  if (!p || p === '/') return true;
  return q === p || q.startsWith(`${p}/`);
}
const prefixLength = (prefix) => { const p = norm(prefix); return !p || p === '/' ? 0 : p.length; };

export function listAreas(site) {
  const areas = site?.url_file_map?.areas;
  return Array.isArray(areas) ? areas.filter((a) => a && typeof a.name === 'string' && a.name.trim()) : [];
}

/** The area a public URL belongs to, or null (no areas declared, or no area claims it). The most specific include wins; exclude always wins. */
export function areaOf(site, url) {
  const areas = listAreas(site);
  if (!areas.length || !url) return null;
  const path = pathOf(url);
  let best = null; let bestLen = -1;
  for (const area of areas) {
    if ((area.exclude || []).some((x) => covers(x, path) && prefixLength(x) > 0)) continue;
    const include = Array.isArray(area.include) && area.include.length ? area.include : ['/'];
    const hit = include.filter((x) => covers(x, path)).map(prefixLength);
    if (!hit.length) continue;
    const len = Math.max(...hit);
    if (len > bestLen) { best = area; bestLen = len; }
  }
  return best;
}

function buildView(site, area) {
  const base = site.url_file_map || {};
  const override = area.override && typeof area.override === 'object' ? area.override : {};
  const map = { ...base };
  delete map.areas;
  for (const key of WHOLE_REPLACE) if (key in override) map[key] = override[key];
  for (const key of MERGED_ONE_LEVEL) if (key in override) map[key] = { ...(base[key] || {}), ...override[key] };
  // Page and pattern tables are the area's own: a page of another area must never resolve here, even by accident.
  if (!('pages' in override)) map.pages = {};
  if (!('patterns' in override)) map.patterns = [];
  Object.defineProperty(map, AREA_VIEW, { value: { area: area.name }, enumerable: false });
  return { ...site, url_file_map: map };
}

/** The site as seen for this URL: the same site object when it has no areas (or none claims the URL), else an area VIEW. */
export function siteForUrl(site, url) {
  const area = areaOf(site, url);
  return area ? buildView(site, area) : site;
}

export function siteForArea(site, name) {
  const area = listAreas(site).find((a) => a.name === name);
  return area ? buildView(site, area) : site;
}

export const isAreaView = (siteOrMap) => Boolean((siteOrMap?.url_file_map || siteOrMap)?.[AREA_VIEW]);
export const areaNameOf = (siteOrMap) => (siteOrMap?.url_file_map || siteOrMap)?.[AREA_VIEW]?.area || null;
