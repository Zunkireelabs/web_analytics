import { analyzePageUrl, requireGroundedContent } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';

export const meta = {
  id: 'qa-content',
  name: 'Q&A Content Generator',
  description: 'Drafts question-style headings with grounded answers for an existing page, to add real extractable Q&A content for AI answer engines — distinct from a full FAQ section, and rendered with the site\'s own real FAQ accordion styling so it never ships as unstyled body copy.',
  recommendationTags: ['Missing question-style headings'],
};

const SYSTEM = 'You are a content strategist. Given a page\'s real body text and (if available) its target query, draft ' +
  '3-5 question-style headings (each phrased as a real question a reader would ask, ending in "?") with a grounded ' +
  '1-2 sentence answer for each. This is extra Q&A content woven into the page\'s existing topic, NOT a generic FAQ ' +
  'box — each question must be about a real subtopic the page text already discusses, not a new unrelated subject. ' +
  'Ground every answer ONLY in the page text and query given — never invent a feature, price, policy, or fact not ' +
  'present in the excerpt. Respond with ONLY a JSON array: [{"question": "...", "answer": "..."}, ...]';

// params: { page: string, query?: string }
export async function generate({ siteId, params }) {
  const { page, query } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
  requireGroundedContent(fetched.analysis, { generatorId: meta.id });

  const user = `Query: ${query || ''}\nPage title: ${fetched.analysis.title}\nPage text: ${fetched.analysis.bodyText.slice(0, 3000)}`;
  let items;
  try {
    items = await callLLMForJson(SYSTEM, user, { maxTokens: 700, generatorId: meta.id, siteId });
    if (!Array.isArray(items)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('Q&A content generation failed: model did not return valid JSON'), { status: 400 });
  }
  // Enforce the real "?" contract server-side — never trust the model alone
  // to have followed the question-phrasing instruction, since this content's
  // entire purpose is to satisfy a check that literally requires it.
  items = items
    .filter((i) => i && typeof i.question === 'string' && typeof i.answer === 'string' && /\?\s*$/.test(i.question.trim()))
    .slice(0, 5);

  // Same deterministic transform faq.js's own schemaJsonLd is, and for the
  // same reason: marker-merge.js's schema-only mode (render-inspector.js's
  // visible-FAQ cap/dedup now applies to this generator too — a page that
  // already has a visible FAQ gets THIS content as structured data only,
  // never a second visible accordion) needs real JSON-LD to publish, not
  // just the visible items.
  const schemaJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.question,
      acceptedAnswer: { '@type': 'Answer', text: i.answer },
    })),
  };

  const content = { page, query: query || null, items, schemaJsonLd };
  return { content, summary: `${items.length} Q&A item(s) for ${page}` };
}
