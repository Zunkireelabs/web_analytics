// The front-matter contract a net-new page must satisfy to render inside its
// target directory's real template — DERIVED from the files already sitting in
// that directory, not guessed from per-site config.
//
// WHY THIS EXISTS
//
// resolveNewContentLayout (url-file-map.js) resolves a new page's `layout`
// from siteRoot.layoutTemplate, with an opt-OUT per target
// (newContentTargets[type].layout = null) for the case where the directory
// already supplies its own layout. That opt-out is correct and its own comment
// describes the exact failure it prevents. Nobody set it.
//
// The result, live on zunkireelabs.com: every agent-written blog post declared
// `layout: "base.njk"`, while src/blog/blog.json declares `layout:
// "blog-post.njk"` for that whole directory. Front matter beats directory
// data, so each post silently downgraded itself out of the blog template —
// losing the breadcrumb, category, read-time, author byline, hero image and
// Article schema that make a post look like a post — and every hand-written
// post in the same folder rendered correctly, because a human knows not to
// write a layout line there.
//
// A second, quieter half of the same mistake: the renderer emits `image:` /
// `image_alt:`, and blog-post.njk reads `featuredImage`. So the Pexels image
// the generator really did fetch was written into the file under a key nothing
// reads, and no post ever showed one.
//
// Both are the same bug: the platform decided a file's contract from its own
// config instead of reading what the directory's existing files actually do.
// The siblings are right there, in the same repo, and they are unambiguous.
//
// So: read them. If they declare no layout, declare none. If they call the
// hero image `featuredImage`, call it `featuredImage`. This needs no per-site
// configuration and fixes every tenant at once, which is the point — the
// opt-out approach would have required a human to notice the problem on each
// site, one directory at a time, after it had already shipped.
//
// FALLBACK: a directory with no readable siblings (a genuinely new one, or a
// repo read that failed) returns nulls, and every caller keeps exactly its
// existing config-derived behavior. Siblings are the authority when they
// exist; their absence is not evidence of anything.

import { getRepoTree, getFileContent, defaultBranchName } from '../../github/client.js';

// How many sibling files to sample. The contract we're reading is a property
// of the directory, not of any one file, so a handful is plenty — and a blog
// folder can hold hundreds.
const MAX_SIBLINGS = 8;

// Canonical field -> the key names real sites use for it, best first. The
// renderer thinks in canonical fields; this maps them onto whatever the
// target directory actually calls them. Order only breaks ties when a
// directory somehow uses more than one.
const FIELD_ALIASES = {
  featuredImage: ['featuredImage', 'image', 'heroImage', 'cover', 'coverImage', 'thumbnail'],
  featuredImageAlt: ['featuredImageAlt', 'imageAlt', 'image_alt', 'coverAlt', 'alt'],
  featuredImageCredit: ['featuredImageCredit', 'imageCredit', 'image_credit', 'credit', 'photoCredit'],
};

// Front-matter KEYS only. Deliberately not a YAML parser: the values are
// irrelevant here (and untrusted tenant content), and a real parser would
// bring failure modes — anchors, multi-document files, tabs — that reading a
// key list does not have. Nested keys are skipped, since a nested key is never
// what a layout reads a scalar field from.
export function frontMatterKeys(raw) {
  if (!raw) return [];
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [];
  const keys = [];
  for (const line of match[1].split('\n')) {
    if (/^\s/.test(line)) continue; // nested/list item, not a top-level key
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// The branch every read below happens on. This used to be
// `ref || site.default_branch || undefined`, and there is no `default_branch`
// column on a site — it is `repo_default_branch`, which is exactly what
// defaultBranchName() reads. So `branch` was always `undefined`, getRepoTree
// asked GitHub for `/git/ref/heads/undefined`, that 404'd, the catch below
// swallowed it as "could not list", and EVERY caller silently fell back to the
// config-derived layout this module exists to replace. The module looked
// correct in tests (which inject their own tree) and was inert in production.
function refFor(site, ref) {
  return ref || defaultBranchName(site);
}

function basename(path) {
  return path.split('/').filter(Boolean).pop() || '';
}

// A file that represents the directory's convention. An index page, a
// directory data file, and a draft are all in the folder without being
// examples of what a post in it looks like.
function isRepresentative(path, extension) {
  const name = basename(path);
  if (!name.endsWith(extension)) return false;
  if (name.startsWith('_') || name.startsWith('.')) return false;
  return !/^index\./i.test(name);
}

const UNKNOWN = Object.freeze({ layout: null, unknown: true, fieldNames: {}, sampled: 0 });

// Reads one file at `path` and returns its front-matter keys plus the layout
// it declares (null when it declares none), or null when there was nothing to
// read. Errors are swallowed on purpose at both levels: one unreadable sibling
// is not evidence about a directory, and the caller distinguishes "learned
// nothing" from "learned there is no layout" by whether it collected any
// samples at all.
async function readFrontMatter(readFile, site, path, ref) {
  let raw;
  try {
    // getFileContent resolves to { content, sha } — or null for a 404 — NOT
    // a bare string. Unwrapping here rather than at each use is what keeps
    // frontMatterKeys' contract "takes file text"; handing it the envelope
    // threw TypeError: raw.match is not a function on the first real call.
    const file = await readFile(site, path, ref);
    raw = typeof file === 'string' ? file : file?.content;
  } catch {
    return null;
  }
  if (!raw) return null; // 404 or empty: same "no evidence" case as a failed read
  const keys = frontMatterKeys(raw);
  if (!keys.length) return null;
  const block = (raw.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const declared = /^layout\s*:\s*"?([^"\n]*)"?\s*$/m.exec(block);
  return { keys, layout: declared ? declared[1].trim() : null };
}

// Turns a set of real files' front matter into the contract a new file in
// their company should satisfy. Shared by the directory-sampling path and the
// single-source-file path (translations) so the two can never disagree about
// what "this file declares no layout" means.
function contractFromSamples(samples) {
  if (!samples.length) return UNKNOWN;

  // If the files that a human wrote declare no layout, a directory data
  // file (Eleventy's blog.json, Astro's collection config, a Next layout) is
  // supplying it, and emitting one would override that. This is the whole
  // reason the module exists, so it is decided by majority rather than by any
  // single file: one stray post with an explicit layout must not flip it.
  // (With a single sample — the translation path — majority degenerates to
  // "do what that one file does", which is exactly the intent there.)
  const layouts = samples.map((s) => s.layout);
  const withLayout = layouts.filter(Boolean);
  const layout = withLayout.length > layouts.length / 2
    ? mostCommon(withLayout)
    : null;

  const observed = new Set(samples.flatMap((s) => s.keys));
  const fieldNames = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const used = aliases.find((alias) => observed.has(alias));
    if (used) fieldNames[canonical] = used;
  }

  return { layout, unknown: false, fieldNames, sampled: samples.length };
}

// ---------------------------------------------------------------------------
// Caching
//
// One derivation costs a full recursive getRepoTree (the whole repo's blob
// list, in one response) plus up to MAX_SIBLINGS getFileContent calls. The
// daily loop ships up to 60 drafts per site per run and every net-new-content
// draft derives its own contract, so without memoization one run refetches the
// identical repo tree dozens of times — and blog-outline and direct-answer on
// this platform's own first client both target src/blog, so many of those
// fetches are byte-for-byte the same question.
//
// This follows agents/lib/template-repair.js's makeSharedPageCache convention
// (read each thing once per pass) with one deliberate difference: the callers
// here are frontend.js's resolveTargetAndBody, reached one draft at a time
// from generateDraft, with no batch-shaped object to hang a per-pass cache
// off. So the default cache is module-level and bounded by a TTL instead —
// short enough that it cannot outlive a single batch run (the loop's two runs
// are hours apart, a run is minutes), and keyed by repo + branch + directory
// so it can never answer for a different site. A caller that DOES have a pass
// to scope to can inject `cache` (or `cache: null` to opt out entirely, which
// is what the tests do so one test's fixture repo can't answer another's).
// ---------------------------------------------------------------------------

const CONTRACT_TTL_MS = 10 * 60 * 1000;
// A ceiling, not a working-set size: (sites × directories) is a handful in
// practice, and the TTL is what actually evicts. This only stops an unbounded
// key space from pinning memory if that assumption ever stops holding.
const MAX_CACHE_ENTRIES = 200;

export function makeContractCache({ ttlMs = CONTRACT_TTL_MS, max = MAX_CACHE_ENTRIES } = {}) {
  const entries = new Map();
  return {
    get(key, now = Date.now()) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      // Expiry is checked on read, not on a timer: an entry nobody asks for
      // again costs nothing, and a timer would keep the process awake.
      if (hit.expiresAt <= now) { entries.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value, now = Date.now()) {
      // Map iterates in insertion order, so the first key is the oldest.
      if (entries.size >= max && !entries.has(key)) entries.delete(entries.keys().next().value);
      entries.set(key, { value, expiresAt: now + ttlMs });
      return value;
    },
    size() { return entries.size; },
  };
}

const sharedContractCache = makeContractCache();

// site.id alone would be enough today, but the repo coordinates are what the
// answer is actually ABOUT — a site repointed at a different repo (or branch)
// keeps its id, and serving it the old repo's layout is the exact class of
// wrong-answer this module was written to stop.
function cacheKey(site, ref, suffix) {
  return `${site.id}|${site.repo_owner}/${site.repo_name}|${ref}|${suffix}`;
}

// `deps.cache === null` disables caching; omitting it uses the shared one.
// Anything else is used as-is, so a caller can scope a cache to its own pass.
function cacheFor(deps) {
  return deps.cache === undefined ? sharedContractCache : deps.cache;
}

async function memoized(cache, key, now, derive) {
  if (!cache) return derive();
  const hit = cache.get(key, now);
  if (hit !== undefined) return hit;
  const value = await derive();
  // A transient failure (403, network blip) must not be pinned for the rest of
  // the TTL — the next draft in the batch should get a real answer. Only a
  // derivation that actually read files is worth remembering. An empty
  // directory re-derives too; that costs one tree fetch and is the rare case.
  if (!value.unknown) cache.set(key, value, now);
  return value;
}

/**
 * Derive the front-matter contract for new files in `dir`, from the files
 * already sitting in it.
 *
 * Returns:
 *   layout          — the layout value siblings declare, or null when they
 *                     declare none (meaning: do NOT emit one, the directory
 *                     supplies it). `unknown: true` when nothing was readable.
 *   fieldNames      — canonical field -> the key name this directory uses.
 *   sampled         — how many siblings the answer is based on.
 */
export async function deriveNewContentContract(site, { dir, extension, ref } = {}, deps = {}) {
  const tree = deps.getRepoTree || getRepoTree;
  const readFile = deps.getFileContent || getFileContent;
  if (!site || !dir || !extension) return UNKNOWN;
  const branch = refFor(site, ref);

  return memoized(cacheFor(deps), cacheKey(site, branch, `${dir}|${extension}`), deps.now, async () => {
    let paths;
    try {
      const { files } = await tree(site, branch);
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      paths = (files || [])
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .filter((p) => isRepresentative(p, extension))
        .slice(0, MAX_SIBLINGS);
    } catch (err) {
      console.warn(`[newcontent-contract] site ${site.id}: could not list ${dir} — ${err.message}`);
      return UNKNOWN;
    }
    if (!paths.length) return UNKNOWN;

    const samples = [];
    for (const path of paths) {
      const sample = await readFrontMatter(readFile, site, path, branch);
      if (sample) samples.push(sample);
    }
    return contractFromSamples(samples);
  });
}

/**
 * The same contract, derived from ONE named file rather than from a
 * directory's siblings.
 *
 * This exists for translations. A translation's target is not a
 * newContentTargets directory at all — resolveTranslationTarget puts it
 * alongside the SOURCE page (src/pages/about.njk -> src/pages/about.es.njk) —
 * and the page it must render like is that one specific source page, which the
 * caller already knows the exact path of. Sampling the whole directory would
 * be strictly less precise: a src/pages folder holds pages built on several
 * different layouts, and a majority vote over them can hand a translation the
 * layout of some other page. The one authority on how /about should look is
 * /about.
 */
export async function deriveContractFromSourceFile(site, filePath, { ref } = {}, deps = {}) {
  const readFile = deps.getFileContent || getFileContent;
  if (!site || !filePath) return UNKNOWN;
  const branch = refFor(site, ref);

  return memoized(cacheFor(deps), cacheKey(site, branch, `file:${filePath}`), deps.now, async () => {
    const sample = await readFrontMatter(readFile, site, filePath, branch);
    return contractFromSamples(sample ? [sample] : []);
  });
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
