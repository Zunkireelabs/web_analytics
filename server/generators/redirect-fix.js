// Pure, deterministic generator — no LLM call. The replacement URL is
// already known and correct: the security/technical-seo agent that detected
// this redirect chain necessarily followed it to its real final
// destination (see server/agents/technical-seo.js's chainFindings). The
// implementer (server/implementers/backend.js) rewrites the specific
// matching <a href> on the page via server/implementers/lib/href-rewrite-inject.js.

export const meta = {
  id: 'redirect-fix',
  name: 'Redirect Link Fix Generator',
  description: "Rewrites a link to its real final destination, skipping an observed redirect chain.",
  recommendationTags: [],
};

// params: { page: string, oldHref: string, newHref: string }
export async function generate({ params }) {
  const { page, oldHref, newHref } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  if (!oldHref || !newHref) throw Object.assign(new Error('oldHref and newHref are required'), { status: 400 });
  try { new URL(newHref); } catch { throw Object.assign(new Error(`"${newHref}" is not a valid URL`), { status: 400 }); }

  return {
    content: { page, oldHref, newHref },
    summary: `${oldHref} → ${newHref}`,
  };
}
