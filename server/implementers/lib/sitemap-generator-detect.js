// Is this site's sitemap.xml produced by its own BUILD? Many repos commit a public/sitemap.xml that a prebuild script rewrites on every
// build (admizz-web-dev: `"prebuild": "... node scripts/generate-sitemap.mjs ..."`). The sitemap implementer writes a complete new XML body into
// the mapped file, which is only right for a hand-maintained static sitemap (see sitemap-guard.js for templates). For a build-generated one the
// edit is thrown away at the next build, and in the meantime it can list URLs the generator deliberately leaves out (noindex posts, private
// pages) - found 2026-11-23 on admizz-web-dev PR #119: 29 of 34 added URLs were excluded on purpose, the other 5 the build already produced.
//
// Detection is deliberately narrow and read-only: package.json scripts that run a sitemap generator, or a known sitemap-generating dependency.
// Anything it cannot read counts as "not detected" (the existing static-file behaviour), never as a block.
const GENERATOR_SCRIPT = /(generate|build|create|make|gen)[-_ ]?sitemap|sitemap[-_ ]?(generate|build|gen)|next-sitemap|sitemap-generator/i;
const GENERATOR_DEPS = ['next-sitemap', 'sitemap-generator', 'gatsby-plugin-sitemap', 'astro-sitemap', 'vite-plugin-sitemap', 'nuxt-simple-sitemap', '@nuxtjs/sitemap'];

// Pure: takes package.json TEXT. Returns { generated: true, reason } or { generated: false }.
export function sitemapGeneratorFromPackageJson(text) {
  let pkg;
  try { pkg = JSON.parse(String(text || '')); } catch { return { generated: false }; }
  if (!pkg || typeof pkg !== 'object') return { generated: false };
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (typeof cmd === 'string' && GENERATOR_SCRIPT.test(cmd)) return { generated: true, reason: `package.json script "${name}" runs a sitemap generator (${cmd.slice(0, 120)})` };
  }
  for (const dep of GENERATOR_DEPS) {
    if (pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]) return { generated: true, reason: `package.json depends on ${dep}, which generates the sitemap at build time` };
  }
  return { generated: false };
}

// fetchFile(path) -> string | { content } | null, bound to the site and branch by the caller.
export async function detectBuildGeneratedSitemap(fetchFile) {
  try {
    const file = await fetchFile('package.json');
    return sitemapGeneratorFromPackageJson(typeof file === 'string' ? file : file?.content);
  } catch {
    return { generated: false };
  }
}

export function generatedSitemapMessage(sitemapPath, reason) {
  return `${sitemapPath || 'The sitemap'} is rebuilt by this site's own build (${reason}), so an edit written to it would be overwritten at the next build and could list pages the generator leaves out on purpose (noindex or private pages). Change the site's sitemap generator instead.`;
}
