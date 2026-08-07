import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { groundingProviderConfigured, searchGroundedSources } from '../ingest/search-grounding-providers/index.js';
import { safeMessage } from '../lib/errors.js';

// Real citation search is opt-in, separate from any one provider's own
// credentials being set (e.g. GOOGLE_CSE_API_KEY, already live for
// competitor intelligence) — citation search would silently start spending
// a shared quota on a different feature without this explicit switch. Which
// specific provider actually serves the search is decided by
// search-grounding-providers/index.js, not hard-coded here, so adding a
// second grounding-capable provider later never requires touching this file.
const CITATION_SEARCH_ENABLED = process.env.ENABLE_CONTENT_CITATION_SEARCH === 'true';

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

// Used when real search results are available for the external-citations focus
// (see CITATION_SEARCH_ENABLED below) — grounded in an actual candidate list
// the same way generators/internal-links.js grounds anchor suggestions in
// real on-site URLs, so the model is citing real pages, not inventing them.
const SYSTEM_CITATIONS_GROUNDED = 'You are a content strategist. Given a page\'s real body text and a list of REAL, already-verified ' +
  'source candidates (title + URL) provided below, draft an external citations/references section. ' +
  'Cite ONLY sources from that candidate list, using markdown links in the exact form [Source Title](URL) with the ' +
  'exact URL given — NEVER invent a URL and NEVER cite anything not in the list. If none of the candidates are ' +
  'actually relevant to the page topic, write the section without a link rather than forcing an irrelevant citation. ' +
  'Respond with ONLY a JSON array: [{"heading": "...", "body": "..."}, ...]';

const FOCUS_SYSTEMS = {
  'author-byline': SYSTEM_AUTHOR,
  'freshness-date': SYSTEM_FRESHNESS,
  'comparison-content': SYSTEM_COMPARISON,
};

// params: { page: string, query?: string, focus?: string }
export async function generate({ siteId, params }) {
  const { page, query, focus } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400, userFacing: true });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400, userFacing: true });

  let system = focus && FOCUS_SYSTEMS[focus] ? FOCUS_SYSTEMS[focus] : SYSTEM_GENERAL;
  let user = `Query: ${query || ''}\nPage title: ${fetched.analysis.title}\nPage text: ${fetched.analysis.bodyText.slice(0, 3000)}`;

  // external-citations has no ungrounded mode: a citation is either backed
  // by a real, verified URL, or it doesn't get drafted at all — writing
  // "an editor should add the real source URL" as body prose (the previous
  // behavior) isn't a safe placeholder like schema.js's [NEEDS INPUT]
  // marker, it's indistinguishable published body text, and it shipped
  // straight to a live page. Fail honestly instead of drafting filler.
  if (focus === 'external-citations') {
    if (!CITATION_SEARCH_ENABLED || !groundingProviderConfigured()) {
      throw Object.assign(new Error('External citations require real search grounding (ENABLE_CONTENT_CITATION_SEARCH + a configured search-grounding provider) — refusing to draft an ungrounded citations section.'), { status: 400, userFacing: true });
    }
    let sources;
    try {
      sources = await searchGroundedSources(query || fetched.analysis.title, 3);
    } catch (err) {
      const { message } = safeMessage('expand-content.searchSources', err, 'Citation search is temporarily unavailable — try again shortly, or draft this section without external citations.');
      throw Object.assign(new Error(message), { status: 502, userFacing: true });
    }
    if (!sources.length) {
      throw Object.assign(new Error('No real source candidates found for this page/query — refusing to draft an ungrounded citations section.'), { status: 400, userFacing: true });
    }
    system = SYSTEM_CITATIONS_GROUNDED;
    user += `\n\nReal source candidates (cite ONLY from this list, using these exact URLs):\n` +
      sources.map((s) => `- ${s.title}: ${s.url}`).join('\n');
  }

  let sections;
  try {
    sections = await callLLMForJson(system, user, { maxTokens: 900, generatorId: meta.id, siteId });
    if (!Array.isArray(sections)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('Content expansion failed: model did not return valid JSON'), { status: 400, userFacing: true });
  }
  sections = sections.filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string').slice(0, 4);

  const content = { page, sections, focus: focus || 'general' };
  const focusLabel = focus ? ` (${focus})` : '';
  return { content, summary: `${sections.length} expanded section(s) for ${page}${focusLabel}` };
}
