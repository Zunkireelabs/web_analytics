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

// What a card for such a fix says. It is NOT a mapping problem (nothing is missing from url_file_map: these pages have no file by design),
// so it must not read as one. The wording is matched by store/recommendations.js's classifyBlockedKind ("numbered page of a list"), which files it
// under "Can't be drafted here: how this page is built" instead of "setup needed".
export const PAGINATED_BLOCKED_REASON = 'This is a numbered page of a list (page 2, 3 and so on of the blog listing): the same listing template showing the next slice of posts, with no file or text of its own. Content fixes are not written onto it; the posts themselves are fixed on their own pages. Nothing needs to be set up.';

// ---- What a finding on a numbered list page really means -----------------------------------------------------------------------------------
// Page 2, 3, 4 of a list are produced by ONE listing template, so a finding about them is a finding about that template, or it is not a
// finding at all. Refusing them with a card for every page number (22 on Zunkiree) meant the real defect was never fixed and the cards came
// back every day.
//
//  - schema: a listing with no listing schema is a template defect. It is fixed ONCE, at the listing the numbered pages belong to
//    (/blog/articles/page/3/ -> /blog/articles/), and the 14 per-page findings collapse into that one item.
//  - FAQ, Q&A, expansion, refresh, direct answer, internal links: a list of post cards is not where those belong, and there is no prose to
//    attach them to. The finding itself is wrong, so it is dropped with the reason on record (never shown as a card to retry).
//  - title (meta-title) is deliberately NOT here: a listing template either numbers its titles or it does not, which is a template fix of
//    its own and is not decided by this rule. It stays the card it was.
export const FIX_AT_LISTING_GENERATORS = Object.freeze(['schema']);
export const NOT_APPLICABLE_ON_LIST_GENERATORS = Object.freeze(['faq', 'qa-content', 'expand-content', 'refresh-content', 'direct-answer', 'internal-links']);

// "https://x.com/blog/articles/page/3/" -> "https://x.com/blog/articles/". Null when the address is not a numbered page.
export function listingUrlFor(pageUrl) {
  if (!isPaginatedListUrl(pageUrl)) return null;
  try {
    const u = new URL(pageUrl);
    u.pathname = u.pathname.replace(/\/page\/\d+\/?$/i, '/');
    u.search = ''; u.hash = '';
    return u.toString();
  } catch {
    return String(pageUrl).replace(/\/page\/\d+\/?(?:[?#].*)?$/i, '/');
  }
}

/** @returns {{kind:'fix-at-listing', listingUrl:string} | {kind:'not-applicable'} | null} */
export function paginatedListDisposition(generatorId, pageUrl) {
  if (!isPaginatedListUrl(pageUrl)) return null;
  if (FIX_AT_LISTING_GENERATORS.includes(generatorId)) return { kind: 'fix-at-listing', listingUrl: listingUrlFor(pageUrl) };
  if (NOT_APPLICABLE_ON_LIST_GENERATORS.includes(generatorId)) return { kind: 'not-applicable' };
  return null;
}
