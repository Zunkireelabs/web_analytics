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

// Side-effect-free re-verification (server/generators/lib/verification-layer.js),
// run before a (re)generate/retry attempt spends a cycle on this
// recommendation. Delegates to the implementer's own read-only merge
// computation (server/implementers/backend.js's computeBrokenLinkFixMerge)
// rather than duplicating its file-resolution/data-source/repo-search logic
// here — that function already IS the real "would this succeed right now"
// check (see its own extensive comments); this just makes it reachable
// generically instead of only from action-center-reconciler.js's
// broken-link-fix-only refusal-recovery path.
//
// Deliberately conservative: only distinguishes `already_resolved` (the
// implementer's own unbounded repo search confirmed the href is hardcoded
// nowhere at all — `merged.stale`) from `still_valid` (every other outcome,
// including a config gap like `no-file-mapping`). Those other failure modes
// already have a tuned, working path to a human via the refusal cap +
// refusal-recovery cycles in ship-pacing.js/action-center-reconciler.js;
// this only adds the one capability that was missing — not writing anything
// for a recommendation whose premise is already gone.
export async function verifyCurrentState(rec, { site, baseBranch: baseBranchOverride } = {}) {
  if (!site) return { decision: 'still_valid', reason: 'no-site-context', evidence: null };
  const page = rec.params?.page;
  const href = rec.params?.href;
  if (!page || !href) return { decision: 'still_valid', reason: 'missing-params', evidence: null };

  const { computeBrokenLinkFixMerge } = await import('../implementers/backend.js');
  const { baseBranch } = await import('../implementers/lib/github-ops.js');
  const ref = baseBranchOverride || baseBranch(site);
  const draft = { content: { page, href, sourcePages: rec.params?.sourcePages } };

  const merged = await computeBrokenLinkFixMerge(site, draft, ref);
  if (merged.stale) {
    return { decision: 'already_resolved', reason: 'confirmed-absent', evidence: { href, attempted: merged.attempted } };
  }
  if (merged.ok) {
    return { decision: 'still_valid', reason: 'fixable-now', evidence: { files: merged.files.map((f) => f.filePath) } };
  }
  return { decision: 'still_valid', reason: merged.reason || 'no-match', evidence: { error: merged.error, attempted: merged.attempted } };
}
