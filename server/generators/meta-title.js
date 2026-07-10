import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'meta-title',
  name: 'Meta Title & Description Generator',
  description: 'Drafts a page title tag and meta description grounded in the real page content and target query.',
  recommendationTags: ['Improve title', 'Improve meta'],
};

// params: { page?: string, query: string }
export async function generate({ params }) {
  const { page, query } = params;
  if (!query) throw Object.assign(new Error('query is required'), { status: 400 });

  let pageContext = null;
  if (page) {
    const fetched = await analyzePageUrl(page);
    if (fetched.ok) pageContext = { currentTitle: fetched.analysis.title, bodyExcerpt: fetched.analysis.bodyText.slice(0, 1500) };
  }

  const system = 'You are an SEO copywriter. Given a real target search query and (if available) the page\'s ' +
    'current title and real body text, draft 3 candidate <title> tags (50-60 characters, include the query\'s ' +
    'core terms naturally, no clickbait) and one meta description (140-160 characters). Ground every claim ONLY ' +
    'in the page content given — never invent a feature, price, or fact not present in the excerpt. If no page ' +
    'content is given, write generically around the query only. Respond with ONLY a JSON object: ' +
    '{"titles": ["...", "...", "..."], "metaDescription": "..."}';
  const user = `Query: ${query}\n${pageContext ? `Current title: ${pageContext.currentTitle}\nPage text: ${pageContext.bodyExcerpt}` : 'No existing page — new content.'}`;
  const raw = await callLLM(system, user, { maxTokens: 400 });

  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('Meta title generation failed: model did not return valid JSON');
  }

  const content = {
    query,
    page: page || null,
    titles: Array.isArray(parsed.titles) ? parsed.titles.slice(0, 3) : [],
    metaDescription: typeof parsed.metaDescription === 'string' ? parsed.metaDescription : '',
  };
  return { content, summary: `${content.titles.length} title option(s) + meta description for "${query}"` };
}
