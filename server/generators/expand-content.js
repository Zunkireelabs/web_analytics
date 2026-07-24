import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

// LLM-backed (same pattern as faq.js) — grounds strictly in the page's real
// fetched text, never invents facts. Serves two call sites with one
// generator (identical output shape — heading + prose sections — just
// different framing): opportunity.js's "Expand content" tag (focus:
// 'expand') and ai-visibility.js's citationReadiness rule (focus:
// 'qa-subheadings', for direct-answer/AEO extraction).

export const meta = {
  id: 'expand-content',
  name: 'Content Expansion Generator',
  description: "Drafts additional body sections (or question-style subheadings) for an existing page, grounded in its real content.",
  recommendationTags: [],
};

const SYSTEM_BY_FOCUS = {
  expand: 'You are a content strategist. Given a page\'s real body text and (if available) its target query, draft ' +
    '2-3 additional body sections covering real subtopics the page text does not yet cover. Each section is a ' +
    'subheading plus 1-2 grounded paragraphs. Ground every claim ONLY in the page text and query given — never ' +
    'invent a feature, price, policy, or fact not present in the excerpt. Respond with ONLY a JSON array: ' +
    '[{"heading": "...", "body": "..."}, ...]',
  'qa-subheadings': 'You are a content strategist writing for AI-answer-engine extraction. Given a page\'s real body ' +
    'text and (if available) its target query, draft 3-4 question-style subheadings (e.g. "What is...", "How does...") ' +
    'each paired with a concise, 1-2 sentence direct answer suitable for featured-snippet/AI-citation extraction. ' +
    'Ground every answer ONLY in the page text given — never invent a fact not present in the excerpt. Respond with ' +
    'ONLY a JSON array: [{"heading": "...", "body": "..."}, ...]',
};

// params: { page: string, query?: string, focus?: 'expand'|'qa-subheadings' }
export async function generate({ params }) {
  const { page, query } = params || {};
  const focus = params?.focus === 'qa-subheadings' ? 'qa-subheadings' : 'expand';
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });

  const system = SYSTEM_BY_FOCUS[focus];
  const user = `Query: ${query || ''}\nPage title: ${fetched.analysis.title}\nPage text: ${fetched.analysis.bodyText.slice(0, 3000)}`;
  const raw = await callLLM(system, user, { maxTokens: 900 });

  let sections;
  try {
    sections = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(sections)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('Content expansion failed: model did not return valid JSON'), { status: 400 });
  }
  sections = sections.filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string').slice(0, 4);

  const content = { page, focus, sections };
  return { content, summary: `${sections.length} ${focus === 'qa-subheadings' ? 'Q&A subheading(s)' : 'expanded section(s)'} for ${page}` };
}
