#!/usr/bin/env node
// Re-survey one site's live page layouts and write PROPOSED group-map changes to a local JSON file.
// Read-only toward production: it reads the site row and fetches public pages; it writes nothing to the
// database. Load the file into the review store only through the review process (never automatically).
//
//   node server/scripts/design-resurvey.js --site 1 --out /path/proposals.json [--capture]
//
// --capture also captures each proposed sample in a real browser, so an approval carries the design data
// it needs. Without it the proposals are structural only.
import { writeFileSync } from 'node:fs';
import { getSiteById } from '../store/read.js';
import { defaultFetchHtml, defaultCaptureFn, pathKey } from '../design-agent/lib/live-design-validation.js';
import { discoverSitemapUrls, surveyPages, proposeFromSurvey } from '../design-agent/lib/design-resurvey.js';
import { sitePageUrl } from '../implementers/lib/design-drift.js';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const siteId = Number(opt('site')); const out = opt('out');
if (!siteId || !out) { console.error('Usage: design-resurvey.js --site <id> --out <file> [--capture]'); process.exit(2); }

const site = await getSiteById(siteId);
const base = sitePageUrl(site).replace(/\/$/, '');
const origin = new URL(base).origin;
const profile = site.url_file_map?.siteRoot?.designProfile || {};
const known = Object.keys(site.url_file_map?.pages || {}).map((p) => new URL(p, `${origin}/`).href);
const fromSitemap = await discoverSitemapUrls(origin, (u) => defaultFetchHtml(u));
const urls = [...new Set([...known, ...fromSitemap])];
console.log(`site ${siteId}: ${known.length} known pages + ${fromSitemap.length} from the sitemap = ${urls.length} unique`);

const { pages, failed } = await surveyPages(urls, (u) => defaultFetchHtml(u));
const { clusters, proposals } = proposeFromSurvey(profile.layoutGroups, pages);

if (args.includes('--capture')) {
  const want = new Set();
  for (const p of proposals) {
    if (p.pagePath && p.kind !== 'join') want.add(p.pagePath);
    for (const pt of p.payload?.parts || []) [pt.sample, ...pt.samples].forEach((x) => want.add(x));
  }
  const entries = new Map();
  for (const path of want) {
    try { entries.set(path, await defaultCaptureFn(new URL(path, `${origin}/`).href)); } catch (err) { console.warn(`capture failed for ${path}: ${err.message}`); }
  }
  for (const p of proposals) {
    if (p.pagePath && entries.has(p.pagePath)) p.entry = entries.get(p.pagePath);
    for (const pt of p.payload?.parts || []) pt.entries = [pt.sample, ...pt.samples].map((x) => entries.get(x)).filter(Boolean);
  }
  console.log(`captured ${entries.size}/${want.size} proposed samples`);
}

writeFileSync(out, JSON.stringify({
  siteId, surveyedAt: new Date().toISOString(), baseRevision: profile.layoutGroups?.revision || 0,
  pagesSurveyed: pages.length, failed, clusters: clusters.map((c) => ({ id: c.id, size: c.members.length, samples: c.samples.map((s) => s.path), members: c.members.map((m) => m.path) })),
  proposals,
}, null, 2), { mode: 0o600 });
console.log(`${pages.length} pages surveyed, ${failed.length} unreadable, ${clusters.length} real layouts, ${proposals.length} proposals -> ${out}`);
const byKind = proposals.reduce((a, p) => ({ ...a, [p.kind]: (a[p.kind] || 0) + 1 }), {});
console.log('proposals by kind:', JSON.stringify(byKind));
process.exit(0);
