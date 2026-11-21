// Page 2, 3, 4... of a paginated list (/blog/page/2/, /de/blog/page/3/) are the same listing template showing the next slice of posts.
// They have no file of their own and no prose of their own, so a content fix there (FAQ, schema, Q&A, expansion, direct answer, title,
// internal links) has nothing to attach to: the shipping loop could only ever fail or refuse it, and it was scored against the generator
// (zunkireelabs-web had about 22 such items on 2026-11-21, every one blocked with "No url_file_map entry resolves ...").
// The paginated URL itself is left alone by every other check (canonical, redirects, robots, sitemap keep working on it).

// Only the path is looked at, and only the unambiguous shape: a final "/page/<number>" segment, on any language prefix.
const PAGINATED_PATH = /\/page\/\d+\/?$/i;

// Generators whose fix is "write content onto this page". Technical checks are not listed, so they still run on a paginated URL.
export const CONTENT_FIX_GENERATORS = Object.freeze([
  'faq', 'schema', 'qa-content', 'expand-content', 'refresh-content', 'direct-answer', 'internal-links', 'meta-title',
]);
const CONTENT_FIX = new Set(CONTENT_FIX_GENERATORS);

export function isPaginatedListUrl(pageUrl) {
  if (!pageUrl) return false;
  let path;
  try { path = new URL(pageUrl, 'https://x.invalid').pathname; } catch { return false; }
  return PAGINATED_PATH.test(path);
}

// True when a recommendation for `generatorId` on `pageUrl` is a content fix on a paginated list page, i.e. one nothing can ship.
export function isUnshippablePaginationFix(generatorId, pageUrl) {
  return CONTENT_FIX.has(generatorId) && isPaginatedListUrl(pageUrl);
}
