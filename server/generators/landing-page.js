import { callLLMForJson } from '../llm.js';
import { getSiteById } from '../store/read.js';
import { pageStructureGuidance } from './lib/design-aware-composer.js';

export const meta = {
  id: 'landing-page',
  name: 'Landing Page Generator',
  description: 'Drafts a landing page structure for a growing market/city or topic — a creative draft, not based on an existing page.',
  recommendationTags: [], // sourced from country-intelligence's growingMarkets/growingCities, not a deterministic gap tag
};

// params: { market?: string, city?: string, topic?: string, context?: string (real supporting data, e.g. session growth) }
export async function generate({ siteId, params }) {
  const { market, city, topic, context } = params;
  const target = city ? `${city}${market ? `, ${market}` : ''}` : (market || topic);
  if (!target) throw Object.assign(new Error('market, city, or topic is required'), { status: 400 });

  const system = 'You are a conversion copywriter. Draft a NEW landing page structure targeting the given market/' +
    'city/topic — this is a fresh, creative draft, not based on an existing page or verified facts about the ' +
    'business beyond what\'s given in context. Do not invent specific claims (pricing, awards, client counts) not ' +
    'present in the given context. Respond with ONLY a JSON object: {"headline": "...", "subheadline": "...", ' +
    '"sections": [{"heading": "...", "body": "..."}], "cta": "...", "metaTitle": "...", "metaDescription": "..."}';
  // DESIGN CONTEXT REACHES GENERATION HERE, not just rendering. Before this,
  // newpage-render.js's projectCta/projectCard/projectPageWrapper already
  // restyled whatever generic shape the LLM invented into the site's real
  // button/card classes — but the STRUCTURE (section count, ordering, which
  // text roles appear) was invented from nothing, identical for every site.
  // pageStructureGuidance (lib/design-aware-composer.js) is the shared
  // composer: it turns this site's own real, live-observed page-type
  // patterns into grounded structural guidance, falling back to 'service'
  // then 'homepage' patterns for a target-type never seen before (a
  // genuinely NEW page type on this site still gets guided by the closest
  // real precedent rather than inventing a structure unrelated to the rest
  // of the site). Null (no profile yet, or this site has shown no page even
  // remotely like this) leaves the prompt exactly as it was before this
  // existed — never a fabricated fallback.
  let site = null;
  try {
    site = siteId != null ? await getSiteById(siteId) : null;
  } catch {
    site = null;
  }
  const guidance = pageStructureGuidance(site, 'landing', { fallbackPageTypes: ['service', 'homepage'] });
  const user = `Target: ${target}${context ? `\nSupporting data: ${context}` : ''}${guidance ? `\n\n${guidance}` : ''}`;
  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { maxTokens: 900, generatorId: meta.id, siteId });
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
