// Pure, deterministic generator — no LLM call. Never guesses a replacement
// target for a genuinely dead (404/error) link — there's no reliable signal
// for "the right page," and fabricating one would be worse than the current
// broken state. Instead drafts the removal of the dead link, keeping its
// real visible text as plain content — always correct, no judgment call.
// The implementer (server/implementers/backend.js) strips the specific
// matching <a href> on the page via server/implementers/lib/href-rewrite-inject.js.

export const meta = {
  id: 'broken-link-fix',
  name: 'Broken Link Removal Generator',
  description: 'Drafts the removal of a dead link, keeping its real visible text as plain content.',
  recommendationTags: [],
};

// params: { page: string, href: string, sourcePages?: string[] }
export async function generate({ params }) {
  const { page, href, sourcePages } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  if (!href) throw Object.assign(new Error('href is required'), { status: 400 });

  // Every page the crawler actually found this href on — not just `page`
  // (kept for back-compat with generic page-lookup code elsewhere). The
  // implementer tries all of them before giving up, since the same dead
  // link is often hardcoded on more than one page's own file.
  const pages = Array.isArray(sourcePages) && sourcePages.length ? sourcePages : [page];

  return {
    content: { page, href, sourcePages: pages },
    summary: `Remove dead link to ${href}`,
  };
}
