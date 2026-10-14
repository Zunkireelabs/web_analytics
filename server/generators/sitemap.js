import { getSiteById } from '../store/read.js';
import { getFileContent, defaultBranchName } from '../github/client.js';
import { listPageInventory, listOrphanedPages } from '../store/page-inventory.js';
import { discoverSitemapEntries } from '../agents/lib/site-discovery.js';

// Pure, deterministic generator — no LLM call, nothing to ground beyond this
// site's own already-discovered pages (page_inventory) and its own live
// sitemap (site-discovery.js's discoverSitemapEntries), same "real data
// only" reasoning as security-headers.js/html-lang.js. Site-level, not
// per-page, like llms-txt.js — and like llms-txt, draft.content.sitemapXml
// is already the complete new file body, so the implementer
// (server/implementers/backend.js) does a straight file write with zero
// content transformation of its own.
//
// Strictly additive-only (v1 scope, see server/implementers/types.js's
// sitemap comment): every existing entry — and its <lastmod>/<changefreq>/
// <priority> — is preserved verbatim; only missing URLs are appended. An
// orphaned sitemap entry (in the sitemap but not reached by the real crawl)
// is surfaced in `orphanedUrls`/`summary` for manual review, never removed
// here.

export const meta = {
  id: 'sitemap',
  name: 'Sitemap Generator',
  description: 'Adds real, already-discovered URLs missing from the site\'s live sitemap.xml — additive only, preserves every existing entry and its metadata.',
  recommendationTags: [],
};

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// This generator is only meant to write a hand-maintained, fully static
// sitemap.xml (see server/implementers/types.js's "Sitemap regeneration"
// comment) — never a template source (Eleventy/Nunjucks/Liquid/Handlebars/
// EJS, ...) that a static-site build renders into sitemap.xml itself. A
// straight overwrite of a templated source with the rendered-XML body this
// generator builds silently deletes the front matter (e.g. Eleventy's
// `permalink: /sitemap.xml`) and the loop that keeps it current — exactly
// what happened to zunkireelabs-web's src/sitemap.njk (Action Center drafts
// #180/#1095), which took the site's live /sitemap.xml offline (404) until
// the front matter was restored by hand.
const TEMPLATE_SOURCE_PATTERN = /^---\r?\n|\{%[-\s]|\{\{[-\s]|<%[-=]?/;

// Exported for tests.
export function looksLikeTemplateSource(raw) {
  return TEMPLATE_SOURCE_PATTERN.test(raw.slice(0, 2000));
}

// Exported for tests. `addedLastmod` is the one real, non-fabricated fact
// available for a newly-added entry (the date this draft added it) —
// priority/changefreq are left absent rather than inventing a value with no
// real signal behind it.
export function buildSitemapXml(existingEntries, newUrls, addedLastmod) {
  const existingBlocks = existingEntries.map((e) => {
    const parts = [`    <loc>${escapeXml(e.loc)}</loc>`];
    if (e.lastmod) parts.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>`);
    if (e.changefreq) parts.push(`    <changefreq>${escapeXml(e.changefreq)}</changefreq>`);
    if (e.priority) parts.push(`    <priority>${escapeXml(e.priority)}</priority>`);
    return `  <url>\n${parts.join('\n')}\n  </url>`;
  });
  const newBlocks = newUrls.map((url) => (
    `  <url>\n    <loc>${escapeXml(url)}</loc>\n    <lastmod>${addedLastmod}</lastmod>\n  </url>`
  ));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...existingBlocks, ...newBlocks].join('\n')}\n</urlset>\n`;
}

// params: { missingUrls?: string[] } — the exact set the sitemap agent found
// missing, same "ground the generator in exactly what the agent found"
// convention as security-headers.js's missingHeaders. Falls back to
// recomputing from page_inventory directly when absent/empty, so this stays
// independently callable (e.g. via the MCP generate_draft tool with no prior
// finding) — same fallback shape as security-headers.js's ALL_KEYS default.
// Every candidate is re-checked against the live sitemap regardless of where
// it came from, so a URL added since the agent last ran is never re-added.
export async function generate({ siteId, params }) {
  const site = await getSiteById(siteId);
  const sitemapPath = site?.url_file_map?.siteRoot?.sitemap;
  if (!sitemapPath) {
    throw Object.assign(new Error(
      'site.url_file_map.siteRoot.sitemap is not configured — set it via `npm run connect-repo` before a sitemap draft can be generated for this site.'
    ), { status: 400 });
  }

  const ref = defaultBranchName(site);
  const file = await getFileContent(site, sitemapPath, ref);
  const raw = typeof file === 'string' ? file : file?.content;
  if (raw && looksLikeTemplateSource(raw)) {
    throw Object.assign(new Error(
      `${sitemapPath} is a template source (front matter or templating syntax found), not a static sitemap.xml — ` +
      'this generator only overwrites a hand-maintained static file. The site\'s own build already regenerates ' +
      'its sitemap from this template, so url_file_map.siteRoot.sitemap should not be set for it at all — unset ' +
      'it via `npm run connect-repo` rather than generating a draft here.'
    ), { status: 400, userFacing: true });
  }

  const [existingEntries, inventory, orphanedPages] = await Promise.all([
    discoverSitemapEntries(site),
    listPageInventory(siteId),
    listOrphanedPages(siteId),
  ]);

  const existingUrlSet = new Set(existingEntries.map((e) => e.loc));
  const candidates = Array.isArray(params?.missingUrls) && params.missingUrls.length
    ? params.missingUrls
    : [...new Set(inventory.map((r) => r.page))];
  const missingUrls = [...new Set(candidates)].filter((url) => !existingUrlSet.has(url)).sort();

  const orphanedUrls = orphanedPages.map((p) => p.page);
  const addedLastmod = new Date().toISOString().slice(0, 10);
  const sitemapXml = buildSitemapXml(existingEntries, missingUrls, addedLastmod);

  const content = { sitemapPath, existingCount: existingEntries.length, addedUrls: missingUrls, orphanedUrls, sitemapXml };

  const summary = missingUrls.length
    ? `Sitemap draft for ${sitemapPath}: adds ${missingUrls.length} URL(s), keeps ${existingEntries.length} existing entr${existingEntries.length === 1 ? 'y' : 'ies'} unchanged` +
      (orphanedUrls.length ? ` (${orphanedUrls.length} existing URL(s) look orphaned — not removed, review manually).` : '.')
    : `No missing URLs found for ${sitemapPath} — sitemap is already up to date.`;

  return { content, summary };
}

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// Re-runs the exact same real-data recompute generate() itself does
// (discoverSitemapEntries + page_inventory, diffed the same way) rather than
// trusting a `missingUrls` param captured whenever the finding was first
// detected — a URL added to the live sitemap by some other means since then
// (a prior draft, a manual edit) must not get a second, now-empty-diff draft.
export async function verifyCurrentState(rec, { site } = {}) {
  if (!site) return { decision: 'still_valid', reason: 'no-site-context', evidence: null };
  const sitemapPath = site?.url_file_map?.siteRoot?.sitemap;
  if (!sitemapPath) return { decision: 'still_valid', reason: 'no-file-mapping', evidence: null };

  const siteId = rec.site_id ?? site.id;
  let existingEntries;
  let inventory;
  try {
    [existingEntries, inventory] = await Promise.all([
      discoverSitemapEntries(site),
      listPageInventory(siteId),
    ]);
  } catch (err) {
    return { decision: 'still_valid', reason: 'unreachable', evidence: { error: err.message } };
  }

  const existingUrlSet = new Set(existingEntries.map((e) => e.loc));
  const candidates = Array.isArray(rec.params?.missingUrls) && rec.params.missingUrls.length
    ? rec.params.missingUrls
    : [...new Set(inventory.map((r) => r.page))];
  const missingUrls = [...new Set(candidates)].filter((url) => !existingUrlSet.has(url));

  if (missingUrls.length === 0) {
    return { decision: 'already_resolved', reason: 'sitemap-already-up-to-date', evidence: { sitemapPath } };
  }
  return { decision: 'still_valid', reason: 'missing-urls-remain', evidence: { sitemapPath, missingCount: missingUrls.length } };
}
