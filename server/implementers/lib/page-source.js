// WHERE DOES THIS PAGE'S CONTENT ACTUALLY LIVE, AND HOW MAY IT BE EDITED?
//
// url_file_map says which file a URL maps to, but a map is a claim, not evidence: a catch-all pattern (`^/([^/]+)/?$` -> `src/app/[slug]/page.tsx`)
// silently sends every page that has its OWN folder, and every page whose text lives in a data file, to one shared template. Writing a page's
// content there changes (or breaks) every page that template renders. This module checks the claim against the real repository tree and
// answers with one of four verified kinds, and the editing method each allows:
//
//   own-file         the page has its own file in the repo (route file or template). Edit that file.
//   data-record      the page is rendered from a data file (a record keyed by its slug in a .ts/.json/.js data module). Edit the data, never the
//                    template that renders it. Which data store depends on what is being changed (an FAQ lives in the FAQ store, not the SEO store).
//   shared-template  the only thing that renders the page is a template shared with other pages. Only a template-level change is allowed.
//   unresolved       nothing could be verified. The agent STOPS and asks for an investigation; it never writes on a guess.
//
// Pure: the tree (list of repo-relative file paths) and a file reader are passed in, so it runs the same against GitHub, a local clone or a test.
import { resolveFile, isSharedTemplateFile } from './url-file-map.js';
import { findCandidateFile, findCandidateFileByDirectoryIndex, normalizedPath } from './discover-file-mapping.js';

export const SOURCE_KIND = Object.freeze({ OWN_FILE: 'own-file', DATA_RECORD: 'data-record', SHARED_TEMPLATE: 'shared-template', UNRESOLVED: 'unresolved' });

const PAGE_EXT = '(?:tsx|jsx|ts|js|mjs|mdx|md|astro|njk|html|liquid|vue)';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A file whose own name is a route parameter ([slug], [id], $slug, _slug) renders many URLs.
export const isDynamicRouteFile = (file) => /\[[^\]]+\]|\/\$\w+\.|\/_\w+\.(?:tsx|jsx|astro)$/.test(`/${file}`) || /\$\d/.test(file);

/**
 * Files in the real tree that are THIS exact URL's own file, by the route conventions of the common stacks. A candidate counts only because it
 * exists in the tree; nothing is inferred from a convention alone.
 */
export function routeFileCandidates(pageUrl, files) {
  const segs = normalizedPath(pageUrl).split('/').filter(Boolean);
  if (!segs.length) return [];
  const p = segs.map(esc).join('/');
  const res = [
    new RegExp(`(?:^|/)app/${p}/page\\.${PAGE_EXT}$`),               // Next.js app router
    new RegExp(`(?:^|/)pages/${p}(?:/index)?\\.${PAGE_EXT}$`),       // Next.js pages router, Astro
    new RegExp(`(?:^|/)src/${p}(?:/index)?\\.${PAGE_EXT}$`),         // Eleventy-style source root
  ];
  const out = new Set(files.filter((f) => !isDynamicRouteFile(f) && res.some((re) => re.test(f))));
  if (!out.size) {
    const byName = findCandidateFile(pageUrl, files);
    if (byName.kind === 'resolved' && !isDynamicRouteFile(byName.file)) out.add(byName.file);
    const byDir = findCandidateFileByDirectoryIndex(pageUrl, files);
    if (byDir.kind === 'resolved' && !isDynamicRouteFile(byDir.file)) out.add(byDir.file);
  }
  return [...out];
}

// ---- data stores -------------------------------------------------------------------------------------------------------------------------------
const DATA_FILE_RE = /(?:^|\/)(?:data|_data|content|posts|blog)\/.*\.(?:json|ts|js|mjs)$|(?:^|\/)[\w-]*(?:posts?|faqs?|seo|summar\w+|patch\w*|facts?|sources?)[\w-]*\.(?:json|ts|js|mjs)$/i;
const MAX_DATA_FILE_BYTES = 600 * 1024;
const MAX_DATA_FILES = 120;

// How a slug appears in a data file. Anything else (a mention in prose) is not a record.
export function slugRecordForms(slug) {
  const s = esc(slug);
  return [
    ['array-record', new RegExp(`["']?(?:slug|id|path|url)["']?\\s*:\\s*["'\`]/?${s}/?["'\`]`)],  // { slug: "x", ... } in an array of records
    ['keyed-map', new RegExp(`^\\s*["']${s}["']\\s*:\\s*[\\[{"'\`]`, 'm')],                          // "x": [ ... ] / "x": { ... } in a map keyed by slug
  ];
}

/** The data files in which `slug` is a record key/field, with the shape it appears in. */
export async function findDataStores(slug, files, readFile) {
  const candidates = files.filter((f) => DATA_FILE_RE.test(f) && !/\.(test|spec)\./.test(f) && !/node_modules|\.next|\/out\//.test(f)).slice(0, MAX_DATA_FILES);
  const forms = slugRecordForms(slug);
  const stores = [];
  for (const f of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(f).catch(() => null);
    if (!text || text.length > MAX_DATA_FILE_BYTES || !text.includes(slug)) continue;
    const hit = forms.find(([, re]) => re.test(text));
    if (hit) stores.push({ file: f, form: hit[0] });
  }
  return stores;
}

// Which store holds what, by the store's own file name (post-faqs.ts holds FAQs, post-seo-overrides.ts holds titles). Never by a guess about contents.
const STORE_ROLE_HINTS = [
  ['faq', /faq/i], ['meta-title', /seo|meta|title/i], ['summary', /summar/i], ['sources', /source/i], ['facts', /fact/i],
  ['content', /content|patch|body/i], ['post', /generated|posts?\b|blog/i],
];
export const storeRoleOf = (file) => STORE_ROLE_HINTS.find(([, re]) => re.test(file.split('/').pop()))?.[0] || 'unknown';

// What each generator edits, so the right store is picked (never "the first data file that mentions the slug").
const GENERATOR_STORE_ROLE = { faq: 'faq', 'meta-title': 'meta-title', 'qa-content': 'faq', 'expand-content': 'content', 'refresh-content': 'content', 'internal-links': 'content', 'content-integrity-repair': 'content', 'direct-answer': 'content' };

// ---- the verdict -------------------------------------------------------------------------------------------------------------------------------
/**
 * @param {{ site: object, pageUrl: string, files: string[], readFile: (path:string)=>Promise<string|null> }} args
 * @returns {Promise<{ kind: string, file?: string, stores?: object[], mapped: string|null, correction?: {from:string|null,to:string,why:string}, reason?: string, candidates?: string[] }>}
 */
export async function resolvePageSource({ site, pageUrl, files, readFile }) {
  const fileSet = new Set(files);
  const mapped = resolveFile(site, pageUrl) || null;
  const mappedExists = mapped ? fileSet.has(mapped) : false;
  const shared = Boolean(mapped) && (isSharedTemplateFile(site, pageUrl) || isDynamicRouteFile(mapped));

  // 1. The mapping names a real, page-specific file: verified.
  if (mapped && mappedExists && !shared) return { kind: SOURCE_KIND.OWN_FILE, file: mapped, mapped };

  const own = routeFileCandidates(pageUrl, files);

  // 2. A real file exists for exactly this URL. If the map pointed somewhere else (a shared catch-all, or a file that no longer exists), the map is wrong.
  if (own.length === 1) {
    const to = own[0];
    return {
      kind: SOURCE_KIND.OWN_FILE, file: to, mapped,
      ...(to !== mapped ? { correction: { from: mapped, to, why: mapped ? (mappedExists ? 'the mapped file is shared by many pages; this page has its own file' : 'the mapped file does not exist in the repository') : 'the page had no mapping' } } : {}),
    };
  }
  if (own.length > 1) return { kind: SOURCE_KIND.UNRESOLVED, mapped, reason: 'ambiguous-own-file', candidates: own };

  // 3. No file of its own. Is its content a record in a data file?
  const slug = normalizedPath(pageUrl).split('/').filter(Boolean).at(-1);
  if (slug) {
    const stores = await findDataStores(slug, files, readFile);
    if (stores.length) return { kind: SOURCE_KIND.DATA_RECORD, file: mapped && mappedExists ? mapped : null, mapped, stores: stores.map((s) => ({ ...s, role: storeRoleOf(s.file) })) };
  }

  // 4. Only a shared template renders it, or nothing verifiable does.
  if (mapped && mappedExists) return { kind: SOURCE_KIND.SHARED_TEMPLATE, file: mapped, mapped };
  return { kind: SOURCE_KIND.UNRESOLVED, mapped, reason: mapped ? 'mapped-file-missing-and-no-own-file' : 'no-source-found' };
}

// ---- the editing method ------------------------------------------------------------------------------------------------------------------------
// Generators that write page-SPECIFIC content (text, links, FAQ items, schema values). They must never write into a shared template.
export const PAGE_CONTENT_GENERATORS = new Set(['faq', 'qa-content', 'expand-content', 'refresh-content', 'internal-links', 'direct-answer', 'content-integrity-repair', 'duplicate-id-fix', 'schema', 'schema-repair', 'alt-text']);
// Generators with a template-level mode (one edit that serves every page of the template).
export const TEMPLATE_LEVEL_GENERATORS = new Set(['breadcrumbs']);
// Data-store forms an adapter can write today.
const WRITABLE_STORE_FORMS = new Set(['array-record', 'keyed-map']);

/**
 * @returns {{ method: 'page-file'|'data-store'|'template-edit'|'investigate', file?: string, store?: object, reason?: string, message?: string }}
 */
export function chooseEditMethod(source, generatorId) {
  if (source.kind === SOURCE_KIND.OWN_FILE) return { method: 'page-file', file: source.file };

  if (source.kind === SOURCE_KIND.DATA_RECORD) {
    const wantRole = GENERATOR_STORE_ROLE[generatorId];
    const matching = wantRole ? source.stores.filter((s) => s.role === wantRole) : [];
    if (matching.length === 1 && WRITABLE_STORE_FORMS.has(matching[0].form)) return { method: 'data-store', store: matching[0] };
    return {
      method: 'investigate', reason: matching.length > 1 ? 'ambiguous-data-store' : 'no-matching-data-store',
      message: `This page's content is stored in data files (${source.stores.map((s) => s.file).join(', ')}), not in a page file. ${matching.length > 1 ? 'More than one of them could hold what this fix changes' : `None of them is the store a "${generatorId}" change belongs in`}, so the agent will not choose one by guess.`,
    };
  }

  if (source.kind === SOURCE_KIND.SHARED_TEMPLATE) {
    if (TEMPLATE_LEVEL_GENERATORS.has(generatorId)) return { method: 'template-edit', file: source.file };
    return {
      method: 'investigate', reason: 'shared-template-page-specific-change',
      message: `This page is rendered by ${source.file}, a template shared with other pages, and nothing in the repository holds this page's own content. A page-specific "${generatorId}" change written there would appear on every page that uses it, so it needs a person to say where this page's content lives.`,
    };
  }

  return { method: 'investigate', reason: source.reason || 'unresolved', message: `The agent could not verify which file holds this page (${source.reason || 'unresolved'}), so it will not write to a guessed file. It needs an investigation.` };
}
