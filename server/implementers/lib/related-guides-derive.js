import { extractRelatedGuidesCard, RELATED_GUIDES_MEASURE } from './related-guides-card.js';
import { listAreas, areaOf } from './site-areas.js';
import { usesStandardSectionOrder } from './section-order.js';

// Works out how a site shows related guides and saves it in the site's map, so the agent draws related guides the way that site does. Run by the daily
// cron (ensureRelatedGuidesTemplates) for every connected site that has not got one saved yet, and by scripts/derive-related-guides-template.js by hand.
//   1. The site already shows related guides as cards on one of its pages -> that card is copied (relatedGuidesCard).
//   2. It has none -> its live look is measured in a real browser and saved for the platform's standard card (relatedGuidesStandard).
// Held-back sites (siteRoot.sectionOrder "off") are skipped, a site that already has one saved is never overwritten, and a failure leaves the site exactly
// as it was: it simply keeps the plain list. Kill switch: RELATED_GUIDES_AUTODERIVE=off.

const defaultGet = async (u) => { try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 superrank-design-capture' }, signal: AbortSignal.timeout(25000) }); return r.ok ? await r.text() : ''; } catch { return ''; } };

export function samplePages(locs, origin, limit = 30) {
  const blogLike = locs.filter((l) => /\/(blog|blogs|guides?|articles?|news|insights|posts?)\//i.test(l));
  const rest = locs.filter((l) => !blogLike.includes(l));
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, limit - Math.min(blogLike.length, 6))));
  const spread = rest.filter((_, i) => i % step === 0);
  return [...new Set([...blogLike.slice(0, 6), ...spread])].filter((l) => l.startsWith(origin) && !/\.(xml|pdf|jpe?g|png|webp|svg)(\?|$)/i.test(l)).slice(0, limit);
}

export function originOf(site) {
  const d = site?.website_domain; if (!d) return null;
  return (/^https?:\/\//i.test(d) ? d : `https://${d}`).replace(/\/+$/, '');
}

export async function candidatePages(site, { get = defaultGet, urlFilter = null, limit = 30 } = {}) {
  const origin = originOf(site); if (!origin) return [];
  const locsOf = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const locs = [];
  for (const path of ['/sitemap.xml', '/sitemap-index.xml']) {
    const xml = await get(`${origin}${path}`); if (!xml) continue;
    const found = locsOf(xml); const subs = found.filter((l) => /\.xml(\?|$)/i.test(l));
    if (subs.length) { for (const sub of subs.slice(0, 4)) locs.push(...locsOf(await get(sub))); } else locs.push(...found);
    if (locs.length) break;
  }
  return samplePages(locs.filter((l) => !/\.xml(\?|$)/i.test(l) && (!urlFilter || urlFilter(l))), origin, limit);
}

export function mutateMap(map, { area = null, relatedGuidesCard = null, relatedGuidesStandard = null, onlyIfMissing = false }) {
  const next = JSON.parse(JSON.stringify(map || {}));
  let target;
  if (area) {
    const a = (next.areas || []).find((x) => x.name === area);
    if (!a) throw new Error(`No area "${area}" in this site's map.`);
    a.override = a.override || {}; a.override.siteRoot = a.override.siteRoot || {}; target = a.override.siteRoot;
  } else {
    if (Array.isArray(next.areas) && next.areas.length) throw new Error('This site has areas: pass --area <name>.');
    next.siteRoot = next.siteRoot || {}; target = next.siteRoot;
  }
  target.componentTemplates = target.componentTemplates || {};
  if (onlyIfMissing && (target.componentTemplates.relatedGuidesCard || target.componentTemplates.relatedGuidesStandard)) return null; // someone saved one meanwhile: change nothing
  delete target.componentTemplates.relatedGuidesCard; delete target.componentTemplates.relatedGuidesStandard;
  if (relatedGuidesCard) target.componentTemplates.relatedGuidesCard = relatedGuidesCard;
  else if (relatedGuidesStandard) target.componentTemplates.relatedGuidesStandard = relatedGuidesStandard;
  return next;
}

export async function defaultMeasure(url) {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { return null; }
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    return await page.evaluate(RELATED_GUIDES_MEASURE);
  } catch { return null; } finally { await browser?.close().catch(() => {}); }
}

/** What this site (or one area of it) should save: { kind: 'card'|'standard', ... } or null when nothing could be worked out. Reads only. */
export async function deriveRelatedGuidesTemplate(site, { urlFilter = null, explicitPages = null, get = defaultGet, measure = defaultMeasure } = {}) {
  const pages = explicitPages?.length ? explicitPages : await candidatePages(site, { get, urlFilter });
  if (!pages.length) return null;
  for (let i = 0; i < pages.length; i += 6) {
    const results = await Promise.all(pages.slice(i, i + 6).map(async (url) => ({ url, r: extractRelatedGuidesCard(await get(url)) })));
    const hit = results.find((x) => x.r.ok);
    if (hit) return { kind: 'card', from: hit.url, relatedGuidesCard: { card: hit.r.card, section: hit.r.section, heading: hit.r.heading, source: hit.url, derivedAt: new Date().toISOString() } };
  }
  const tokens = await measure(pages[0]);
  return tokens ? { kind: 'standard', from: pages[0], relatedGuidesStandard: { ...tokens, measuredAt: new Date().toISOString() } } : null;
}

const hasTemplate = (siteRoot) => Boolean(siteRoot?.componentTemplates?.relatedGuidesCard || siteRoot?.componentTemplates?.relatedGuidesStandard);

/**
 * The daily step: for each connected site (and each area of a site with areas) that has no related-guides template saved, derive one and save it.
 * Returns [{ area, outcome }] where outcome is one of saved-card | saved-standard | present | held | skipped:<why> | none-found | error:<message>. Never throws.
 */
export async function ensureRelatedGuidesTemplates(site, { patch, get = defaultGet, measure = defaultMeasure, env = process.env, log = console } = {}) {
  const out = [];
  try {
    if (env.RELATED_GUIDES_AUTODERIVE === 'off') return [{ area: null, outcome: 'skipped:switched-off' }];
    if (!site?.repo_owner || !site?.repo_name) return [{ area: null, outcome: 'skipped:no-repo' }];
    if (!originOf(site)) return [{ area: null, outcome: 'skipped:no-domain' }];
    if (!usesStandardSectionOrder(site)) return [{ area: null, outcome: 'held' }];
    const areas = listAreas(site);
    const targets = areas.length ? areas.map((a) => ({ name: a.name, siteRoot: a.override?.siteRoot, urlFilter: (u) => areaOf(site, u)?.name === a.name, held: a.override?.siteRoot?.sectionOrder === 'off' })) : [{ name: null, siteRoot: site.url_file_map?.siteRoot, urlFilter: null, held: false }];
    for (const t of targets) {
      if (t.held) { out.push({ area: t.name, outcome: 'held' }); continue; }
      if (hasTemplate(t.siteRoot)) { out.push({ area: t.name, outcome: 'present' }); continue; }
      try {
        const derived = await deriveRelatedGuidesTemplate(site, { urlFilter: t.urlFilter, get, measure });
        if (!derived) { out.push({ area: t.name, outcome: 'none-found' }); continue; }
        const res = await patch(site.id, (map) => mutateMap(map, { area: t.name, relatedGuidesCard: derived.relatedGuidesCard || null, relatedGuidesStandard: derived.relatedGuidesStandard || null, onlyIfMissing: true }));
        out.push({ area: t.name, outcome: res?.changed === false ? 'present' : `saved-${derived.kind}` });
      } catch (err) { out.push({ area: t.name, outcome: `error:${String(err.message).slice(0, 120)}` }); }
    }
  } catch (err) { log.error?.(`[related-guides] site ${site?.id}: ${err.message}`); return [{ area: null, outcome: `error:${String(err.message).slice(0, 120)}` }]; }
  return out;
}
