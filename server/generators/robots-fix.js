// Pure, deterministic generator — no LLM call, no file read (this platform's
// generators never touch the live/target file themselves — see
// server/generators/types.js). Drafts a surgical `Allow:` override rather
// than editing/removing the existing Disallow rule: robots.txt's longest-
// match precedence (RFC 9309, same rule server/agents/lib/site-discovery.js's
// parseRobotsDisallowRules implements) means a specific `Allow: /page` beats
// a broader `Disallow: /prefix`, so this never widens access beyond the one
// real, already-indexed page the finding was about — everything else the
// broad Disallow covers stays exactly as protected as before.

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
