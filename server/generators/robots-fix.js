// Pure, deterministic generator — no LLM call, no file read (this platform's
// generators never touch the live/target file themselves — see
// server/generators/types.js). Drafts a surgical `Allow:` override rather
// than editing/removing the existing Disallow rule: robots.txt's longest-
// match precedence (RFC 9309, same rule server/agents/lib/site-discovery.js's
// parseRobotsDisallowRules implements) means a specific `Allow: /page` beats
// a broader `Disallow: /prefix`, so this never widens access beyond the one
// real, already-indexed page the finding was about — everything else the
// broad Disallow covers stays exactly as protected as before.

import { fetchTextIfExists } from '../agents/lib/page-content.js';
import { parseRobotsDisallowRules } from '../agents/lib/site-discovery.js';
import { siteOriginFor } from '../agents/lib/site-domain.js';

export const meta = {
  id: 'robots-fix',
  name: 'Robots.txt Fix Generator',
  description: 'Drafts a robots.txt rule change to stop wrongly disallowing an indexable page.',
  recommendationTags: [],
};

// params: { pagePath: string, blockedPattern: string|null }
export async function generate({ params }) {
  const { pagePath, blockedPattern } = params || {};
  if (!pagePath) throw Object.assign(new Error('pagePath is required'), { status: 400 });

  const robotsBlock = blockedPattern
    ? `# SEOAI: un-block indexable page previously caught by "Disallow: ${blockedPattern}"\nAllow: ${pagePath}`
    : `# SEOAI: un-block indexable page\nAllow: ${pagePath}`;

  return {
    content: { robotsBlock, pagePath, blockedPattern: blockedPattern || null },
    summary: blockedPattern ? `Allow ${pagePath} (was blocked by ${blockedPattern})` : `Allow ${pagePath}`,
  };
}

// Side-effect-free re-verification (server/generators/lib/verification-layer.js).
// Re-parses the live robots.txt with the same RFC 9309 longest-match logic
// (site-discovery.js's parseRobotsDisallowRules) technical-seo.js's own
// detection uses, rather than trusting whether `blockedPattern` (captured at
// detection time) is still the actual rule in force — a robots.txt edited by
// someone else between detection and drafting could have removed the
// blocking rule entirely, or changed which rule wins.
export async function verifyCurrentState(rec, { site } = {}) {
  if (!site) return { decision: 'still_valid', reason: 'no-site-context', evidence: null };
  const pagePath = rec.params?.pagePath;
  if (!pagePath) return { decision: 'still_valid', reason: 'missing-params', evidence: null };
  const origin = siteOriginFor(site);
  if (!origin) return { decision: 'still_valid', reason: 'no-checkable-target', evidence: null };

  const fetched = await fetchTextIfExists(`${origin}/robots.txt`);
  if (!fetched.ok) {
    // No real robots.txt at all to disallow anything — nothing left to fix.
    return { decision: 'already_resolved', reason: 'no-robots-txt', evidence: { origin } };
  }
  const rules = parseRobotsDisallowRules(fetched.text);
  if (rules.isAllowed(pagePath)) {
    return { decision: 'already_resolved', reason: 'already-allowed', evidence: { pagePath } };
  }
  return { decision: 'still_valid', reason: 'still-disallowed', evidence: { pagePath, matchingDisallow: rules.matchingDisallow(pagePath) } };
}
