import { findNamedExport, listTopLevelEntries, parseDataLiteral } from '../adapters/lib/ts-export-data.js';
import { inferTableMarkup } from '../adapters/lib/portable-text-body.js';
import { extractTableCss } from '../adapters/lib/rich-post-html.js';

// A SHARED TEMPLATE IS DESIGN; EACH PAGE'S CONTENT LIVES IN ITS OWN STORE.
//
// /[slug]/page.tsx on a Next.js site renders every blog post, but the post's FAQ is in `src/data/post-faqs.ts` under the post's slug, its search title in
// `src/data/post-seo-overrides.ts`, its text in `src/content/blog/posts/<slug>.json`. A fix for ONE post belongs in those stores, never in the template. The gate used to
// stop at "this page resolves to a shared template" because nothing told it where the stores were, even though the template says so itself: it imports them and
// indexes them by the page's key (`postFaqs[post.slug.current]`).
//
// This reads that evidence and nothing else. It never runs code, never guesses: a store is reported only when (1) the template imports it, (2) the template indexes
// it by a key, (3) the data file really exports a plain keyed record, and (4) the record's entries have a shape one of our adapters writes. Whether a NEW key may be
// created is decided the same way, from evidence: only when every existing key of the record names a real file at one common path (`src/content/blog/posts/{key}.json`).

const DATA_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
const DEFAULT_IMPORT = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
const CONTENT_FILE = /\.(json|md|mdx|ya?ml|toml)$/i;

/** Pure. [{ localName, importedName, importPath }] for every named/default import. */
export function importsOf(source) {
  const out = [];
  for (const m of String(source || '').matchAll(DATA_IMPORT)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const [imported, local] = t.split(/\s+as\s+/).map((s) => s.trim());
      out.push({ importedName: imported, localName: local || imported, importPath: m[2] });
    }
  }
  for (const m of String(source || '').matchAll(DEFAULT_IMPORT)) out.push({ importedName: 'default', localName: m[1], importPath: m[2] });
  return out;
}

/** Pure. Names that the source indexes by a key: `name[ something ]`. A name that is only passed around or iterated is not keyed by page. */
export function keyedNames(source, names) {
  const text = String(source || '');
  return names.filter((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\s*\\[(?!\\s*\\])`).test(text));
}

/** Pure. "@/data/post-faqs" or "../data/x" to a repo path that exists in `repoFiles`, or null. */
export function resolveImportPath(importPath, templateFile, repoFiles) {
  const files = new Set(repoFiles);
  let base;
  if (importPath.startsWith('@/')) base = `src/${importPath.slice(2)}`;
  else if (importPath.startsWith('.')) {
    const parts = templateFile.split('/'); parts.pop();
    for (const seg of importPath.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
    base = parts.join('/');
  } else return null; // a package, never a data file of this repo
  for (const ext of ['', ...EXTENSIONS]) if (files.has(base + ext) && /\.(ts|tsx|js|mjs)$/.test(base + ext)) return base + ext;
  return null;
}

const isFaqItem = (v) => v && typeof v === 'object' && typeof v.question === 'string' && typeof v.answer === 'string';
const isSeoFields = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.title === 'string' && typeof v.description === 'string';

/** Pure. What kind of content a record's sampled entries are, or null when no adapter of ours writes that shape. */
export function classifyRecordShape(values) {
  const sample = values.filter((v) => v != null);
  if (sample.length < 2) return null; // one entry proves nothing about a convention
  if (sample.every((v) => Array.isArray(v) && v.length > 0 && v.every(isFaqItem))) return 'faq';
  if (sample.every(isSeoFields)) return 'meta-title';
  return null;
}


/** Pure. True when the data file's own opening comment says it holds schema only (nothing visible), so newly written content must not go there. */
export function isSchemaOnlyStore(content) {
  const head = String(content || '').split('\n').slice(0, 14).filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).join(' ');
  return /schema[\s-]*only|no visible markup|never (use|put) this for/i.test(head);
}

/**
 * Pure. The one path pattern under which (almost) every existing key has a real file, e.g. `src/content/blog/posts/{key}.json`. Proves a new key names a real page.
 * Needs at least 5 keys and 95% agreement; otherwise null and new keys may NOT be created.
 */
export function inferKeyEvidence(keys, repoFiles) {
  if (keys.length < 5) return null;
  const set = new Set(repoFiles);
  const votes = new Map();
  for (const key of keys) {
    for (const file of repoFiles) {
      if (!file.includes(`/${key}.`)) continue;
      const m = /^(.*\/)([^/]+)\.([A-Za-z0-9]+)$/.exec(file);
      // Only a CONTENT file proves a page exists. An image named after the key (public/images/og/<key>.jpg) can outlive the post or be made in advance.
      if (!m || m[2] !== key || !CONTENT_FILE.test(file)) continue;
      const tpl = `${m[1]}{key}.${m[3]}`;
      votes.set(tpl, (votes.get(tpl) || 0) + 1);
    }
  }
  let best = null; let bestN = 0;
  for (const [tpl, n] of votes) if (n > bestN) { best = tpl; bestN = n; }
  if (!best || bestN / keys.length < 0.95) return null;
  // Re-prove it against the repo itself, not only the votes: the template must name a file for the keys it was counted on.
  const hits = keys.filter((k) => set.has(best.replace('{key}', k))).length;
  return hits / keys.length >= 0.95 ? { file: best } : null;
}

/**
 * @param {object} o
 * @param {string} o.templateFile   repo path of the shared template, e.g. src/app/[slug]/page.tsx
 * @param {string} o.templateSource its text
 * @param {string[]} o.repoFiles    every file path in the repo
 * @param {(path:string)=>Promise<string|null>} o.readFile
 * @returns {Promise<{ stores: {actionType:string, adapter:object, evidence:object}[], skipped: {name:string, reason:string}[] }>}
 *   adapter has no `urlPattern`: that comes from the url_file_map pattern that matched the page, which only the caller knows.
 */
export async function discoverTemplateDataStores({ templateFile, templateSource, repoFiles, readFile }) {
  const stores = []; const skipped = [];
  const imports = importsOf(templateSource).filter((i) => i.importedName !== 'default');
  const keyed = new Set(keyedNames(templateSource, imports.map((i) => i.localName)));
  const seen = new Set();
  for (const imp of imports) {
    if (!keyed.has(imp.localName)) continue;
    const dataFile = resolveImportPath(imp.importPath, templateFile, repoFiles);
    if (!dataFile) { skipped.push({ name: imp.localName, reason: 'import is not a data file of this repo' }); continue; }
    if (seen.has(`${dataFile}#${imp.importedName}`)) continue;
    seen.add(`${dataFile}#${imp.importedName}`);
    const content = await readFile(dataFile);
    if (content == null) { skipped.push({ name: imp.importedName, reason: `${dataFile} could not be read` }); continue; }
    if (isSchemaOnlyStore(content)) { skipped.push({ name: imp.importedName, reason: `${dataFile} says it holds schema only (no visible content), so new content is never written there` }); continue; }
    const exp = findNamedExport(content, imp.importedName);
    if (!exp.ok || exp.kind !== 'object') { skipped.push({ name: imp.importedName, reason: 'not a plain keyed record' }); continue; }
    const listed = listTopLevelEntries(content, exp.start, exp.end);
    if (!listed.ok || listed.entries.length < 2) { skipped.push({ name: imp.importedName, reason: 'entries could not be listed' }); continue; }
    const values = listed.entries.slice(0, 12).map((e) => { const p = parseDataLiteral(content.slice(e.valueStart, e.valueEnd)); return p.ok ? p.value : null; });
    const actionType = classifyRecordShape(values);
    if (!actionType) { skipped.push({ name: imp.importedName, reason: 'entry shape is not one our adapters write' }); continue; }
    const evidence = inferKeyEvidence(listed.entries.map((e) => e.key), repoFiles);
    const base = { dataFile, exportName: imp.importedName };
    const adapter = actionType === 'faq'
      ? { id: 'ts-named-export-content', ...base, shape: 'keyed-record' }
      : { id: 'ts-keyed-record-fields', ...base };
    if (evidence) { adapter.allowCreateKey = true; adapter.keyEvidence = evidence; }
    stores.push({ actionType, adapter, evidence: { keys: listed.entries.length, keyEvidence: evidence } });
  }
  // Two stores that serve the same action cannot both be the adapter for it, and picking one would be a guess. Neither is configured.
  const counts = stores.reduce((m, s) => m.set(s.actionType, (m.get(s.actionType) || 0) + 1), new Map());
  const kept = [];
  for (const st of stores) {
    if (counts.get(st.actionType) > 1) skipped.push({ name: st.adapter.exportName, reason: `more than one store could take ${st.actionType} content, so none is chosen automatically` });
    else kept.push(st);
  }
  return { stores: kept, skipped };
}

/**
 * Where the BODY of a post lives, when a post is a JSON file of Portable Text blocks (Admizz: src/content/blog/posts/<slug>.json rendered by PortableTextRenderer).
 * Evidence only: (1) the keys of a keyed store the template reads are backed by content files at one common path (`keyEvidence`, already proven by
 * inferKeyEvidence), (2) a real one of those files parses to an object with a `content` array of `block` items, (3) the template imports a component whose source
 * says PortableText, (4) the site's own table markup is taken from tables its existing posts already contain (never invented).
 * @returns {Promise<{ adapter: object, evidence: object } | null>}
 */
export async function discoverPostBodyStore({ templateFile, templateSource, repoFiles, readFile, keyEvidence, sampleLimit = 60 }) {
  if (!keyEvidence?.file || !/\.json$/i.test(keyEvidence.file) || !keyEvidence.file.includes('{key}')) return null;
  const [pre, post] = keyEvidence.file.split('{key}');
  const postFiles = repoFiles.filter((f) => f.startsWith(pre) && f.endsWith(post) && !f.slice(pre.length, f.length - post.length).includes('/'));
  if (postFiles.length < 5) return null;

  const posts = [];
  for (const f of postFiles.slice(0, sampleLimit)) {
    const text = await readFile(f);
    try { const j = JSON.parse(text); if (j && Array.isArray(j.content)) posts.push(j); } catch { /* not a post file */ }
  }
  // Most posts must be block text. Some can be whole pages pasted in as one raw-HTML block (a quarter of Admizz's): the adapter refuses those one by one.
  const withBlocks = posts.filter((j) => j.content.some((b) => b?._type === 'block')).length;
  if (posts.length < 5 || withBlocks / posts.length < 0.7) return null;

  let rendererFile = null;
  for (const imp of importsOf(templateSource)) {
    const path = resolveImportPath(imp.importPath, templateFile, repoFiles) || (imp.importPath.startsWith('@/') ? [`src/${imp.importPath.slice(2)}.tsx`, `src/${imp.importPath.slice(2)}.jsx`].find((x) => repoFiles.includes(x)) : null);
    if (!path) continue;
    const src = await readFile(path);
    if (src && /PortableText/.test(src) && /types\s*:\s*\{/.test(src)) { rendererFile = path; break; }
  }
  if (!rendererFile) return null;

  const tableMarkup = inferTableMarkup(posts.map((j) => j.content.filter((b) => b?._type === 'rawHtml').map((b) => b.html).join('\n')));
  const adapter = { id: 'portable-text-post-body', contentFile: keyEvidence.file, rendererFile, bodyField: 'content' };
  if (tableMarkup) {
    adapter.tableMarkup = { wrapperClass: tableMarkup.wrapperClass, tableClass: tableMarkup.tableClass };
    // The site's stylesheet that defines those table classes: a file the renderer imports and whose source holds RICH_POST_CSS (admizz-web-dev:
    // src/components/lib/blog-rich-styles.ts). Found only if it really defines them; its rules are copied into a raw-HTML page that lacks them.
    const rendererSource = await readFile(rendererFile);
    for (const imp of importsOf(rendererSource || '')) {
      const f = resolveImportPath(imp.importPath, rendererFile, repoFiles) || (imp.importPath.startsWith('@/') ? [`src/${imp.importPath.slice(2)}.ts`, `src/${imp.importPath.slice(2)}.tsx`].find((x) => repoFiles.includes(x)) : null);
      const src = f ? await readFile(f) : null;
      if (src && extractTableCss(src, adapter.tableMarkup)) { adapter.tableCssFile = f; break; }
    }
  }
  return { adapter, evidence: { postFiles: postFiles.length, sampled: posts.length, rendererFile, tableMarkupPosts: tableMarkup?.posts ?? 0 } };
}
