import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'expand-content',
  name: 'Content Expansion Generator',
  description: 'Drafts additional body sections for an existing page, grounded in its real content. Supports focused expansions for GEO signals: author-byline, freshness-date, comparison-content, external-citations.',
  recommendationTags: ['author-byline', 'freshness-date', 'comparison-content', 'external-citations'],
};

const SYSTEM_GENERAL = 'You are a content strategist. Given a page\'s real body text and (if available) its target query, draft ' +
  '2-3 additional body sections covering real subtopics the page text does not yet cover. Each section is a ' +
  'subheading plus 1-2 grounded paragraphs. Ground every claim ONLY in the page text and query given — never ' +
  'invent a feature, price, policy, or fact not present in the excerpt. Respond with ONLY a JSON array: ' +
  '[{"heading": "...", "body": "..."}, ...]';

const SYSTEM_AUTHOR = 'You are a content strategist. Given a page\'s real body text, draft an author/byline section that can be added to the page. ' +
  'The section should include a plausible author name/role based on the content topic, and schema.org Author markup guidance. ' +
  'Do NOT invent a specific real person — use a placeholder like "By [Author Name], [Role]" with guidance on where to add real author schema. ' +
  'Respond with ONLY a JSON array: [{"heading": "...", "body": "..."}, ...]';

const SYSTEM_FRESHNESS = 'You are a content strategist. Given a page\'s real body text, draft a "Last Updated" or "Published On" section with schema.org datePublished/dateModified markup guidance. ' +
  'Do NOT invent a specific date — use a placeholder with guidance on where to add the real date. ' +
  'Respond with ONLY a JSON array: [{"heading": "...", "body": "..."}, ...]';

const SYSTEM_COMPARISON = 'You are a content strategist. Given a page\'s real body text and target query, draft a comparison/alternatives section. ' +
  'Include a comparison table structure or "X vs Y" style content grounded in the page topic. ' +
  'Do NOT invent specific competitor names or features not in the page text — use placeholders with guidance. ' +
  'Respond with ONLY a JSON array: [{"heading": "...", "body": "..."}, ...]';

const SYSTEM_CITATIONS = 'You are a content strategist. Given a page\'s real body text, draft an external citations/references section. ' +
  'Include placeholder citations to authoritative sources relevant to the page topic, with guidance on replacing with real sources. ' +
  'Respond with ONLY a JSON array: [{"heading": "...", "body": "..."}, ...]';

const FOCUS_SYSTEMS = {
  'author-byline': SYSTEM_AUTHOR,
  'freshness-date': SYSTEM_FRESHNESS,
  'comparison-content': SYSTEM_COMPARISON,
  'external-citations': SYSTEM_CITATIONS,
};

// params: { page: string, query?: string, focus?: string }
export async function generate({ params }) {
  const { page, query, focus } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });

  const system = focus && FOCUS_SYSTEMS[focus] ? FOCUS_SYSTEMS[focus] : SYSTEM_GENERAL;
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

  const content = { page, sections, focus: focus || 'general' };
  const focusLabel = focus ? ` (${focus})` : '';
  return { content, summary: `${sections.length} expanded section(s) for ${page}${focusLabel}` };
}
