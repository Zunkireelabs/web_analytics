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

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// Same shape as broken-link-fix.js's own verifyCurrentState, but simpler:
// redirect-fix targets exactly one known, mapped file (no data-source layers,
// no repo-wide search fallback), so that file's own content is the full,
// authoritative answer — no "coverage incomplete" ambiguity to worry about.
// If `oldHref` is no longer in it, the source link was already changed or
// removed by some other edit, and this recommendation's premise is gone.
export async function verifyCurrentState(rec, { site, baseBranch: baseBranchOverride } = {}) {
  if (!site) return { decision: 'still_valid', reason: 'no-site-context', evidence: null };
  const { page, oldHref, newHref } = rec.params || {};
  if (!page || !oldHref || !newHref) return { decision: 'still_valid', reason: 'missing-params', evidence: null };

  const { computeRedirectFixMerge } = await import('../implementers/backend.js');
  const { baseBranch } = await import('../implementers/lib/github-ops.js');
  const ref = baseBranchOverride || baseBranch(site);

  const merged = await computeRedirectFixMerge(site, { content: { page, oldHref, newHref } }, ref);
  if (merged.ok) {
    return { decision: 'still_valid', reason: 'fixable-now', evidence: { filePath: merged.filePath } };
  }
  if (merged.reason === 'no-match') {
    return { decision: 'already_resolved', reason: 'no-match', evidence: { oldHref, filePath: merged.filePath ?? null } };
  }
  return { decision: 'still_valid', reason: merged.reason || 'unknown', evidence: { error: merged.error } };
}
