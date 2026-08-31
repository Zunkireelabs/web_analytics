// Excludes a directory's own index/listing page from the Eleventy collection
// its directory data file assigns to every file in that directory.
//
// WHY THIS EXISTS
//
// Confirmed live on zunkireelabs.com/blog/: the FIRST card in the blog grid
// was the blog listing page itself — title "AI & Technology Blog | Insights
// from Zunkiree Labs" (the page's own SEO title, not a post), no featured
// image (the grid's placeholder gradient+icon), and its "Read article" link
// pointed at /blog/ — the page you were already on. Clicking it never took a
// reader "inside" a real article, because it wasn't one.
//
// The cause is a real, pre-existing site-configuration bug, not anything the
// AI agent generated: src/blog/blog.json sets `"tags": ["blog"]` for the
// WHOLE directory (Eleventy's directory-data-cascade), and nothing in
// index.njk's own front matter opts out — so index.njk inherits that tag and
// Eleventy's `collections.blog` includes the listing page as if it were one
// of its own posts. index.njk's `{% for post in collections.blog %}` loop
// then renders itself as a card, permalink `/blog/` and all.
//
// The fix is Eleventy's own documented mechanism for exactly this shape: an
// `eleventyExcludeFromCollections: true` front-matter flag on the listing
// page. It removes the page from every tag-derived collection while changing
// nothing else about how it renders.
//
// Scope: any directory whose OWN data file (dirname.json/dirname.11tydata.js)
// assigns tags to the whole directory, and whose own index file has neither
// that flag nor an explicit `tags:` override of its own. Not blog-specific —
// this shape (a listing page living in the same directory as the items it
// lists) recurs on any Eleventy site, so a second tenant with a /guides/ or
// /case-studies/ index next to its own directory data file gets the same check.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function hasKey(rawFrontMatter, key) {
  return new RegExp(`^${key}\\s*:`, 'm').test(rawFrontMatter || '');
}

/**
 * @param {string} repoDir a real directory containing the repo's `src/`
 * @param {string} dir     the directory to check, relative to repoDir, e.g. "src/blog"
 * @param {{write?: boolean}} [opts]
 * @returns {{ok: boolean, reason?: string, fixed: boolean, indexFile?: string}}
 */
export async function fixCollectionSelfInclusion(repoDir, dir, { write = false } = {}) {
  const full = path.join(repoDir, dir);
  let entries;
  try {
    entries = await readdir(full);
  } catch {
    return { ok: false, reason: 'directory-not-found', fixed: false };
  }

  // A directory data file assigning `tags` to the whole directory — Eleventy's
  // two conventional shapes: `<dirname>.json` or `<dirname>.11tydata.js`.
  const dirName = path.basename(dir);
  const dataFile = entries.find((f) => f === `${dirName}.json` || f === `${dirName}.11tydata.js`);
  if (!dataFile) return { ok: true, fixed: false, reason: 'no-directory-data-file' };

  const dataRaw = await readFile(path.join(full, dataFile), 'utf8');
  if (!/["']?tags["']?\s*[:=]/.test(dataRaw)) return { ok: true, fixed: false, reason: 'directory-data-has-no-tags' };

  const indexName = entries.find((f) => /^index\.(njk|md|html|11ty\.js)$/i.test(f));
  if (!indexName) return { ok: true, fixed: false, reason: 'no-index-file' };

  const indexPath = path.join(full, indexName);
  const raw = await readFile(indexPath, 'utf8');
  const fm = (FRONT_MATTER.exec(raw) || ['', ''])[1];

  // Already opted out one way or another — either the flag is set, or the
  // index page declares its own `tags:` that overrides the directory's.
  if (hasKey(fm, 'eleventyExcludeFromCollections') || hasKey(fm, 'tags')) {
    return { ok: true, fixed: false, reason: 'already-excluded' };
  }

  if (!FRONT_MATTER.test(raw)) return { ok: true, fixed: false, reason: 'no-front-matter-block' };

  const updated = raw.replace(FRONT_MATTER, (whole, body) => `---\n${body}\neleventyExcludeFromCollections: true\n---`);
  if (write) await writeFile(indexPath, updated);
  return { ok: true, fixed: true, indexFile: path.join(dir, indexName) };
}
