import { getSiteById } from '../store/read.js';
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
