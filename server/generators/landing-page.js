import { callLLMForJson } from '../llm.js';

export const meta = {
  id: 'landing-page',
  name: 'Landing Page Generator',
  description: 'Drafts a landing page structure for a growing market/city or topic — a creative draft, not based on an existing page.',
  recommendationTags: [], // sourced from country-intelligence's growingMarkets/growingCities, not a deterministic gap tag
};

// params: { market?: string, city?: string, topic?: string, context?: string (real supporting data, e.g. session growth) }
export async function generate({ params }) {
  const { market, city, topic, context } = params;
  const target = city ? `${city}${market ? `, ${market}` : ''}` : (market || topic);
  if (!target) throw Object.assign(new Error('market, city, or topic is required'), { status: 400 });

  const system = 'You are a conversion copywriter. Draft a NEW landing page structure targeting the given market/' +
    'city/topic — this is a fresh, creative draft, not based on an existing page or verified facts about the ' +
    'business beyond what\'s given in context. Do not invent specific claims (pricing, awards, client counts) not ' +
    'present in the given context. Respond with ONLY a JSON object: {"headline": "...", "subheadline": "...", ' +
    '"sections": [{"heading": "...", "body": "..."}], "cta": "...", "metaTitle": "...", "metaDescription": "..."}';
  const user = `Target: ${target}${context ? `\nSupporting data: ${context}` : ''}`;
  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { maxTokens: 900 });
  } catch {
    throw Object.assign(new Error('Landing page generation failed: model did not return valid JSON'), { status: 400 });
  }

  const content = {
    target,
    headline: parsed.headline || '',
    subheadline: parsed.subheadline || '',
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    cta: parsed.cta || '',
    metaTitle: parsed.metaTitle || '',
    metaDescription: parsed.metaDescription || '',
  };
  return { content, summary: `Landing page draft for "${target}"` };
}
