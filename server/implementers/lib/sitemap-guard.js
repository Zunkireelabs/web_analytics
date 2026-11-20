// The sitemap implementer writes a COMPLETE new XML body into the file mapped at url_file_map.siteRoot.sitemap. That is
// only safe for a hand-maintained static sitemap.xml. When the mapped file is a template that BUILDS the sitemap
// (Eleventy .njk with front matter and loops, Liquid, etc.), overwriting it with XML freezes today's page list and
// silently drops every page added afterwards. Found 2026-11-20: one project's mapping points at such a template.
const TEMPLATE_SYNTAX = /\{%|\{\{|<%|^---\s*$/m;

export function isTemplatedSitemap(content) {
  return TEMPLATE_SYNTAX.test(String(content || ''));
}
