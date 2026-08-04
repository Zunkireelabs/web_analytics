import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

// LLM-backed (same pattern as faq.js) — grounds strictly in the page's real
// fetched text, never invents facts. Drafts additional body sections
// covering real subtopics the page doesn't yet cover — used by
// opportunity.js's "Expand content" tag.
//
// Used to also serve a 'qa-subheadings' focus (ai-visibility.js's
// citationReadiness rule) that spliced bare question-form subheadings
// straight into body copy. Retired 2026-08-03: in production this rendered
// as a second, visually inconsistent Q&A pattern next to the site's real FAQ
// accordion (no "Frequently asked questions" heading, no collapse, different
// typography) — confusing on any page since it read as a broken/mismatched
// FAQ. That signal is now folded into the regular 'faq' recommendation
// rules instead (see ai-visibility.js), so this generator only ever drafts
// real expansion content again.

export const meta = {
  id: 'expand-content',
  name: 'Content Expansion Generator',
  description: 'Drafts additional body sections for an existing page, grounded in its real content.',
  recommendationTags: [],
};

const SYSTEM = 'You are a content strategist. Given a page\'s real body text and (if available) its target query, draft ' +
  '2-3 additional body sections covering real subtopics the page text does not yet cover. Each section is a ' +
  'subheading plus 1-2 grounded paragraphs. Ground every claim ONLY in the page text and query given — never ' +
  'invent a feature, price, policy, or fact not present in the excerpt. Respond with ONLY a JSON array: ' +
  '[{"heading": "...", "body": "..."}, ...]';

// params: { page: string, query?: string }
export async function generate({ params }) {
  const { page, query } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });

  const user = `Query: ${query || ''}\nPage title: ${fetched.analysis.title}\nPage text: ${fetched.analysis.bodyText.slice(0, 3000)}`;
  const raw = await callLLM(SYSTEM, user, { maxTokens: 900 });

  let sections;
  try {
    sections = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(sections)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('Content expansion failed: model did not return valid JSON'), { status: 400 });
  }
  sections = sections.filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string').slice(0, 4);

  const content = { page, sections };
  return { content, summary: `${sections.length} expanded section(s) for ${page}` };
}
