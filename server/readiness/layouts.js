// Reads the LAYOUT CHAIN of a page (its layout, that layout's own layout, and the includes they pull in) so the readiness run can learn two things
// from the site's own files instead of assuming them:
//   - which tags the layout builds from variables (Open Graph, canonical): there is then no per-page tag to mark, and
//   - which front-matter key the layout renders as the page's title and description (`metaDescription`, `description`, `excerpt`, ...).
// Eleventy/Jekyll-style `layout:` front matter with `{% include "x" %}`, and Astro's `import Layout from '...'` for the first component of a page.

const EXT_TRIES = ['', '.njk', '.html', '.liquid', '.hbs', '.astro'];
const norm = (p) => { const out = []; for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg !== '.' && seg !== '') out.push(seg); } return out.join('/'); };
const dir = (p) => p.split('/').slice(0, -1).join('/');

export function layoutRef(content) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  if (!fm) return null;
  const m = /^layout\s*:\s*["']?([^\s"']+)["']?\s*$/m.exec(fm[1]) || /"layout"\s*:\s*"([^"]+)"/.exec(fm[1]);
  return m ? m[1] : null;
}
export const includeRefs = (text) => [...String(text || '').matchAll(/\{%-?\s*include\s+["']([^"']+)["']/g)].map((m) => m[1]);

function astroLayoutPath(pagePath, content) {
  const body = String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '');
  const tag = /<([A-Z][\w]*)/.exec(body);
  if (!tag) return null;
  const imp = new RegExp(`import\\s+${tag[1]}\\s+from\\s+['"]([^'"]+)['"]`).exec(content || '');
  return imp ? norm(`${dir(pagePath)}/${imp[1]}`) : null;
}

export async function collectLayoutText({ pagePath, pageContent, readFile, repoFiles, siteLayoutPath = null, maxDepth = 4 }) {
  const files = new Set(repoFiles.map((f) => (typeof f === 'string' ? f : f.path)));
  const seen = new Set(); const texts = [];
  const findInclude = (ref) => {
    for (const root of ['src/_includes', '_includes', 'src/_layouts', '_layouts', 'layouts', 'src/layouts']) for (const e of EXT_TRIES) { const c = norm(`${root}/${ref}${e}`); if (files.has(c)) return c; }
    return null;
  };
  async function visit(path, depth) {
    if (!path || seen.has(path) || depth > maxDepth) return;
    seen.add(path);
    const text = await readFile(path);
    if (text == null) return;
    texts.push(text);
    const next = layoutRef(text);
    if (next) await visit(findInclude(next), depth + 1);
    for (const inc of includeRefs(text)) await visit(findInclude(inc), depth + 1);
  }
  const first = layoutRef(pageContent);
  if (first) await visit(findInclude(first), 1);
  const astro = astroLayoutPath(pagePath, pageContent);
  if (astro && files.has(astro)) await visit(astro, 1);
  if (!texts.length && siteLayoutPath) await visit(siteLayoutPath, 1);
  return texts.join('\n');
}

// The front-matter key behind `<meta name="description" content="{{ x }}">` and `<title>{{ x }}</title>`: the variable itself, or what a `{% set x = key ... %}`
// makes it. null when the layout does not say.
function keyBehind(text, variable) {
  const v = variable.replace(/^page\./, '').replace(/^data\./, '');
  const set = new RegExp(`\\{%-?\\s*set\\s+${v}\\s*=\\s*([A-Za-z_][\\w]*)`).exec(text);
  return set ? set[1] : v;
}
export function deriveKeys(text) {
  const t = String(text || ''); const out = {};
  const d = /<meta\s+name=["']description["'][^>]*content=["']\{\{\s*([A-Za-z_][\w.]*)/.exec(t);
  if (d) out.description = keyBehind(t, d[1]);
  const ti = /<title>\s*\{\{\s*([A-Za-z_][\w.]*)/.exec(t);
  if (ti) out.title = keyBehind(t, ti[1]);
  return out;
}
