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

import { getRepoTree, getFileContent } from '../../github/client.js';

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

/**
 * Derive the front-matter contract for new files in `dir`.
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
  const unknown = { layout: null, unknown: true, fieldNames: {}, sampled: 0 };
  if (!site || !dir || !extension) return unknown;

  let paths;
  try {
    const branch = ref || site.default_branch || undefined;
    const { files } = await tree(site, branch);
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    paths = (files || [])
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .filter((p) => isRepresentative(p, extension))
      .slice(0, MAX_SIBLINGS);
  } catch (err) {
    console.warn(`[newcontent-contract] site ${site.id}: could not list ${dir} — ${err.message}`);
    return unknown;
  }
  if (!paths.length) return unknown;

  const keySets = [];
  const layouts = [];
  for (const path of paths) {
    let raw;
    try {
      raw = await readFile(site, path, ref || site.default_branch || undefined);
    } catch {
      continue; // one unreadable sibling is not evidence about the directory
    }
    const keys = frontMatterKeys(raw);
    if (!keys.length) continue;
    keySets.push(keys);
    const declared = /^layout\s*:\s*"?([^"\n]*)"?\s*$/m.exec((raw.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '');
    layouts.push(declared ? declared[1].trim() : null);
  }
  if (!keySets.length) return unknown;

  // If the siblings that a human wrote declare no layout, a directory data
  // file (Eleventy's blog.json, Astro's collection config, a Next layout) is
  // supplying it, and emitting one would override that. This is the whole
  // reason the module exists, so it is decided by majority rather than by any
  // single file: one stray post with an explicit layout must not flip it.
  const withLayout = layouts.filter(Boolean);
  const layout = withLayout.length > layouts.length / 2
    ? mostCommon(withLayout)
    : null;

  const observed = new Set(keySets.flat());
  const fieldNames = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const used = aliases.find((alias) => observed.has(alias));
    if (used) fieldNames[canonical] = used;
  }

  return { layout, unknown: false, fieldNames, sampled: keySets.length };
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
