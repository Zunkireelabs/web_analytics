// Pure, deterministic generator — same shape as soft-404-nginx.js: the real
// work (finding the exact live rule, refusing if ambiguous/stale/already
// resolved) happens in the implementer (server/implementers/lib/
// redirect-chain-nginx-inject.js) right before the write.

export const meta = {
  id: 'redirect-chain-nginx',
  name: 'Redirect Chain Collapse Generator',
  description: 'Drafts the nginx fix that collapses a multi-hop redirect (a location=/return or rewrite rule) down to point directly at the chain\'s final destination.',
  recommendationTags: [],
};

// params: { page, currentHopTarget, finalTarget } — page is the chain's
// SOURCE (the URL this platform observed redirecting through 2+ hops),
// currentHopTarget is the very next hop the real redirect walk observed
// (what the implementer must still find live before it trusts anything),
// finalTarget is where the chain actually ends up.
export async function generate({ params }) {
  const { page, currentHopTarget, finalTarget } = params || {};
  if (!page || !currentHopTarget || !finalTarget) {
    throw Object.assign(new Error('page, currentHopTarget, and finalTarget are all required'), { status: 400 });
  }
  return {
    content: { page, currentHopTarget, finalTarget },
    summary: `Collapse redirect chain: ${page} → (${currentHopTarget}) → ${finalTarget} becomes a single hop.`,
  };
}
