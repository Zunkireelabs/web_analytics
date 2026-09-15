// Pure, deterministic generator — nothing to ground against an LLM. The
// fix is a single fixed line swap; the real work (finding the exact live
// line, refusing if it's ambiguous or already fixed) happens in the
// implementer (server/implementers/lib/soft-404-inject.js) right before the
// write, same division of labor as security-headers.js.

export const meta = {
  id: 'soft-404-nginx',
  name: 'Soft-404 Fallback Generator',
  description: 'Drafts the nginx fix that makes an unmatched route return a real 404 status instead of silently serving the homepage.',
  recommendationTags: [],
};

export async function generate() {
  return {
    content: {},
    summary: 'Change the catch-all nginx route to return a real 404 status for any URL that doesn\'t match a real page, instead of serving the homepage with a 200.',
  };
}
