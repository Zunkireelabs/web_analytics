import { getSearchPerformanceRange } from '../store/read.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'blog-outline',
  name: 'Blog Outline Generator',
  description: 'Drafts a structured outline for a new post covering a topic the site doesn\'t yet serve, with real internal-link suggestions.',
  recommendationTags: [], // sourced from content-gap's aiSuggestions, not a deterministic gap tag
};

const CANDIDATE_LIMIT = 20;
const DEFAULT_WINDOW_DAYS = 90;

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// params: { topic: string, context?: string, start?: string, end?: string }
export async function generate({ siteId, params }) {
  const { topic, context } = params;
  if (!topic) throw Object.assign(new Error('topic is required'), { status: 400 });
  const { start, end } = params.start && params.end ? params : defaultRange();

  const otherPages = await getSearchPerformanceRange(siteId, start, end, 'page', CANDIDATE_LIMIT);
  const candidates = otherPages.map((p) => p.dim_value);
  const candidateSet = new Set(candidates);

  const system = 'You are a content strategist. Draft a structured outline for a NEW blog post covering the ' +
    'given topic — this is a fresh piece, not based on an existing page, so treat it as a creative draft, not a ' +
    'fact-check. If internal-link candidate URLs are given, you may suggest linking to them where topically ' +
    'relevant (choosing ONLY from that list — never invent a URL). Respond with ONLY a JSON object: ' +
    '{"title": "...", "metaDescription": "...", "sections": [{"heading": "...", "notes": "..."}], ' +
    '"suggestedFaqTopics": ["...", "..."], "suggestedInternalLinks": [{"anchorText": "...", "targetUrl": "..."}]}';
  const user = `Topic: ${topic}${context ? `\nContext: ${context}` : ''}\n\nInternal link candidates:\n${candidates.join('\n') || '(none available)'}`;
  const raw = await callLLM(system, user, { maxTokens: 900 });

  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error('Blog outline generation failed: model did not return valid JSON'), { status: 400 });
  }

  const suggestedInternalLinks = (Array.isArray(parsed.suggestedInternalLinks) ? parsed.suggestedInternalLinks : [])
    .filter((s) => s && typeof s.anchorText === 'string' && candidateSet.has(s.targetUrl));

  const content = {
    topic,
    title: parsed.title || '',
    metaDescription: parsed.metaDescription || '',
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    suggestedFaqTopics: Array.isArray(parsed.suggestedFaqTopics) ? parsed.suggestedFaqTopics : [],
    suggestedInternalLinks,
  };
  return { content, summary: `Outline draft for "${topic}" (${content.sections.length} section(s))` };
}
