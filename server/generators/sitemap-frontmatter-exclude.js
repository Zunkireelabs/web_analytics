// Pure, deterministic generator — no LLM call. Same "real work happens in
// the implementer at apply time" shape as sitemap-removal.js/soft-404-
// nginx.js: this only carries the page and the site-verified front-matter
// field name forward (implementers/lib/sitemap-frontmatter-exclude-
// inject.js does the actual exact-match front-matter edit).

export const meta = {
  id: 'sitemap-frontmatter-exclude',
  name: 'Sitemap Front-Matter Exclusion Generator',
  description: 'Sets this page\'s own sitemap-exclusion front-matter flag, for sites whose sitemap.xml is generated at build time from a template loop rather than hand-maintained as static XML.',
  recommendationTags: [],
};

// params: { page: string, field: string } — `field` is the exact front-
// matter key this site's own sitemap template checks (sites.url_file_map.
// siteRoot.sitemapExcludeField, verified per-tenant — never a guessed
// default; see recommendedAction construction in agents/sitemap-conflict.js).
export async function generate({ params }) {
  const { page, field } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  if (!field) throw Object.assign(new Error('field is required'), { status: 400 });
  return {
    content: { page, field },
    summary: `Set "${field}: true" in ${page}'s own front matter to exclude it from the generated sitemap.`,
  };
}
