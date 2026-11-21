// Guards for the three places that WRITE a whole site-root file (llms.txt, and a brand-new robots.txt), so a wrong mapping or a template
// can never be silently destroyed.
//
// Two real hazards found on 2026-11-21 reading client repos:
//  1. A mapped path that does not exist (chayce: siteRoot.llmsTxt = src/llms.txt, while the real source is src/llms.njk with
//     `permalink: "llms.txt"`). Writing it would create a SECOND source for /llms.txt, and Eleventy fails a build when two inputs write
//     the same output.
//  2. A mapped path that is a template (zennly: src/robots.njk and src/llms.njk, each opening with front matter that carries the
//     `permalink`). A whole-file overwrite drops the front matter, the file stops being served at its URL, and robots.njk also loses its
//     `{% if env == "production" %}` guard that keeps staging out of search.
// (The sitemap write already refuses a template: see sitemap-guard.js.)

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function splitFrontMatter(content) {
  const text = String(content ?? '');
  const m = text.match(FRONT_MATTER);
  return m ? { frontMatter: m[0].endsWith('\n') ? m[0] : `${m[0]}\n`, body: text.slice(m[0].length) } : { frontMatter: null, body: text };
}

export const hasTemplateSyntax = (content) => /\{\{|\{%/.test(String(content ?? ''));
export const isTemplatedFile = (content) => splitFrontMatter(content).frontMatter !== null || hasTemplateSyntax(content);

// Other source files an SSG could use to produce the same output URL as `path` (llms.txt <- llms.njk, llms.md, ...).
export function siblingSourcePaths(path) {
  const m = String(path || '').match(/^(.*)\.(txt|xml)$/i);
  if (!m) return [];
  return ['njk', 'liquid', 'md', 'html', 'hbs', 'ejs', 'astro', 'js', 'ts', 'mjs'].map((ext) => `${m[1]}.${ext}`);
}

/**
 * @param {{ path: string, kind: 'llms'|'robots-bootstrap', readFile: (p: string) => Promise<{content: string}|null> }} p
 * @returns {Promise<{ok: true, mode: 'create'|'overwrite'|'keep-front-matter', frontMatter?: string} | {ok: false, reason: string, error: string}>}
 *   llms: overwrite a plain file; keep a template's front matter and replace only its body; never create next to an existing source.
 *   robots-bootstrap: only ever CREATES. An existing file means the live site is missing robots.txt for a build or deploy reason.
 */
export async function guardSiteRootWrite({ path, kind, readFile }) {
  const existing = await readFile(path);
  if (kind === 'robots-bootstrap') {
    if (existing) {
      return {
        ok: false, reason: 'file-exists',
        error: `${path} already exists in the repository${isTemplatedFile(existing.content) ? ' (as a template)' : ''}, yet the live site serves no robots.txt. That is a build or deploy problem, not missing content, and overwriting the file would lose its settings. A person needs to find why it is not published.`,
      };
    }
  } else if (existing) {
    const { frontMatter } = splitFrontMatter(existing.content);
    return frontMatter ? { ok: true, mode: 'keep-front-matter', frontMatter } : { ok: true, mode: 'overwrite' };
  }
  for (const sibling of siblingSourcePaths(path)) {
    if (await readFile(sibling)) {
      return {
        ok: false, reason: 'output-conflict',
        error: `${path} is not in the repository, but ${sibling} is and probably produces the same URL. Creating ${path} as well would give the build two files for one output. Fix siteRoot in url_file_map to point at ${sibling}.`,
      };
    }
  }
  return { ok: true, mode: 'create' };
}
