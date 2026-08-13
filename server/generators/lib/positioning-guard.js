// Product-visibility growth objective, Phase 4: does a drafted landing page
// actually communicate what's being offered, does its CTA match that
// offering, and does the offering match a REAL verified capability
// (product_capabilities, migration 111) rather than something the
// generator's own LLM call invented while drafting?
//
// Deliberately scoped to landing-page only (see runQualityGate) — a blog
// article has no CTA/offering to evaluate the same way, and every other
// generator (meta-title, schema, alt-text, ...) has no positioning concept
// at all. Skipped entirely when a site has no verified capabilities yet
// (nothing real to check against — same "don't invent a problem with
// nothing to check against" discipline classifyGapRelevance already
// follows), so a site still in Phase 1 setup never gets a spurious failure
// here.
import { callLLMForJson } from '../../llm.js';
import { getProductCapabilities } from '../../store/data-analyst.js';

const POSITIONING_SYSTEM = 'You review a drafted landing page against a company\'s REAL, verified product ' +
  'capabilities — never invent or assume a capability not in the given list. Respond with ONLY a JSON object: ' +
  '{"issues": ["<short, specific problem>", ...]} (empty array if none). Flag an issue ONLY for a real, concrete ' +
  'problem: (1) the headline/subheadline don\'t make it clear what is actually being offered, (2) the CTA doesn\'t ' +
  'match what the page offers, or (3) the page describes a capability that doesn\'t match any of the given verified ' +
  'ones (a plausible-sounding but invented product). Do not flag style, tone, or length — only these three.';

function pageSummary(content) {
  const sections = (content.sections || [])
    .map((s) => `${s.heading || ''}: ${s.body || ''}`)
    .join('\n');
  return `Headline: ${content.headline || ''}\nSubheadline: ${content.subheadline || ''}\nCTA: ${content.cta || ''}\n\nSections:\n${sections}`;
}

export async function checkPositioning(content, siteId) {
  if (!content || typeof content !== 'object') return [];

  const capabilities = await getProductCapabilities(siteId, 'verified').catch(() => []);
  if (!capabilities.length) return [];

  const capabilityList = capabilities
    .map((c) => `- ${c.name}${c.category ? ` (${c.category})` : ''}${c.description ? `: ${c.description}` : ''}`)
    .join('\n');
  const user = `Drafted landing page:\n${pageSummary(content)}\n\nVerified capabilities:\n${capabilityList}`;

  try {
    const parsed = await callLLMForJson(POSITIONING_SYSTEM, user, { maxTokens: 300, generatorId: 'positioning-guard', siteId });
    const issues = Array.isArray(parsed?.issues) ? parsed.issues.filter((i) => typeof i === 'string' && i.trim()) : [];
    return issues.map((snippet) => ({ path: 'positioning', patternId: 'positioning-mismatch', snippet }));
  } catch (e) {
    // A failed check must never block a draft that's otherwise fine — same
    // fail-open discipline classifyGapRelevance/findExistingPageMatch use.
    // An LLM outage shouldn't be indistinguishable from a real positioning
    // problem.
    console.warn(`[positioning-guard] check failed: ${e.message}`);
    return [];
  }
}
