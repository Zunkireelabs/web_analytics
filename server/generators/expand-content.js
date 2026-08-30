import { analyzePageUrl, requireGroundedContent } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { groundingProviderConfigured, searchGroundedSources } from '../ingest/search-grounding-providers/index.js';
import { safeMessage } from '../lib/errors.js';
import { getSiteById } from '../store/read.js';
import { hasAuthorProfile, authorByline, organizationByline } from './lib/author-profile.js';

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

// No LLM call for freshness-date (see below): the prior prompt asked the
// LLM to write a placeholder date, but content-scaffolding-guard.js's
// placeholder-bracket pattern exists specifically to reject that shape of
// text, so this focus failed the Quality Gate on EVERY attempt, for EVERY
// page — the same guaranteed-to-fail class as the author-byline focus
// above. Unlike an author name, a missing datePublished/dateModified has a
// real, verifiable fix that needs no LLM and no placeholder at all:
// today's actual date is the true, honest "last updated" date for content
// being published right now — same convention schema.js's DATE_FIELD_RE
// auto-fill already uses for the same field.

// `table` is an OPTIONAL structured array of plain {column: value} rows,
// every row using the SAME set of keys in the SAME order (the first row's
// keys decide the columns) — never markdown or HTML for the table itself.
// This exists because a freeform "draft the table as text" instruction
// produced three different, inconsistent shapes: GFM pipe-table markdown, a
// raw HTML <table> string, and (once) this exact structured shape invented
// unprompted. Only the last is safe to render at all — the other two are
// either arbitrary syntax marker-merge.js has to parse out of the free-form
// body, or arbitrary CSS the model invented that has nothing to do with the
// site's real design. Making it an explicit field means marker-merge.js's
// renderComparisonTable can build the table with the site's OWN styling
// (or a plain zero-CSS default), the same way every other structured
// content type here already works — never trusting model-authored markup.
const SYSTEM_COMPARISON = 'You are a content strategist. Given a page\'s real body text and target query, draft a comparison/alternatives section. ' +
  'Write 1-2 grounded lead-in sentences for "body", and — only if there are at least 2 real, meaningfully different points of comparison grounded ' +
  'in the page text — also include a "table" field: an array of plain objects, one per comparison row, every object using the exact same keys in the ' +
  'same order (e.g. [{"feature": "...", "zunkiree_labs": "...", "alternative": "..."}, ...]). Every table VALUE must be a short plain string, never markdown or HTML. ' +
  'Do NOT invent specific competitor names or features not in the page text — use placeholders with guidance, and omit "table" entirely rather than fabricate rows. ' +
  'Respond with ONLY a JSON array: [{"heading": "...", "body": "...", "table": [...]}, ...] ("table" may be omitted per item)';

// Caps and validates the optional structured "table" field SYSTEM_COMPARISON
// asks for above: an array of plain objects, every value a short string,
// every row sharing the first row's key set. Anything else (missing, wrong
// shape, a single row that isn't really a comparison, oversized) is dropped
// entirely rather than partially patched — a malformed table would either
// crash or mislead marker-merge.js's renderComparisonTable, and this
// section's grounded "body" prose still ships fine either way.
const MAX_TABLE_ROWS = 12;
const MAX_TABLE_COLUMNS = 6;
const MAX_TABLE_CELL_LENGTH = 200;

export function sanitizeTable(table) {
  if (!Array.isArray(table) || !table.length) return undefined;
  const first = table[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const columns = Object.keys(first).slice(0, MAX_TABLE_COLUMNS);
  if (!columns.length) return undefined;
  const rows = table.slice(0, MAX_TABLE_ROWS).map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const out = {};
    for (const col of columns) {
      const value = row[col];
      if (typeof value !== 'string' && typeof value !== 'number') return null;
      out[col] = String(value).slice(0, MAX_TABLE_CELL_LENGTH);
    }
    return out;
  }).filter(Boolean);
  return rows.length >= 2 ? rows : undefined; // a "table" of one row isn't a comparison
}

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
  'comparison-content': SYSTEM_COMPARISON,
};

// params: { page: string, query?: string, focus?: string }
export async function generate({ siteId, params }) {
  const { page, query, focus } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400, userFacing: true });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400, userFacing: true });
  requireGroundedContent(fetched.analysis, { generatorId: meta.id });

  // EEAT — a site with a real configured author (sites.author_name,
  // migration 090) never needs the LLM to draft a "[Author Name]"
  // placeholder byline: the real name is already known, so this is a
  // deterministic transform, not a generation. Only drafted when the site's
  // own policy actually wants a VISIBLE byline (require_visible_byline) —
  // a site that wants author EEAT via schema only (schema.js already
  // handles that for Article-like types) gets a clear refusal instead of an
  // unwanted visible section, same "fail honestly instead of drafting
  // filler" principle external-citations already uses below.
  if (focus === 'author-byline') {
    const site = await getSiteById(siteId);
    if (hasAuthorProfile(site)) {
      if (!site.require_visible_byline) {
        throw Object.assign(
          new Error('This site\'s author profile is configured for schema-only attribution (require_visible_byline is off) — refusing to add an unwanted visible byline section. Schema author markup is already handled by the schema generator.'),
          { status: 400, userFacing: true },
        );
      }
      const byline = authorByline(site);
      const content = { page, sections: [{ heading: 'About the Author', body: byline }], focus };
      return { content, summary: `Author byline for ${page}: "${byline}"` };
    }
    // No individual author configured: fall back to the site's own real
    // organization name (organizationByline — schema.org's `author` accepts
    // an Organization as validly as a Person), not an LLM call. This used
    // to ask the LLM to write "By [Author Name], [Role]" — a fake persona
    // on a real business's page, which is worse for EEAT than no byline,
    // not better — and content-scaffolding-guard.js's author-placeholder
    // pattern exists specifically to reject exactly that bracket text, so
    // this focus failed the Quality Gate on EVERY attempt, for EVERY site
    // with no individual author configured — a guaranteed, permanent
    // failure surfaced as a generic "try again shortly" error, not the
    // flaky case that message implies. A site can still configure a real
    // named individual (Settings) later to get authorByline() above
    // instead; this is fully automatic in the meantime, zero manual step.
    const byline = organizationByline(site);
    const content = { page, sections: [{ heading: 'About the Author', body: byline }], focus };
    return { content, summary: `Author byline for ${page}: "${byline}"` };
  }

  if (focus === 'freshness-date') {
    // The section body IS the published page copy (see renderExpandedHtml
    // in marker-merge.js) — it must read as a real sentence a visitor would
    // see, not implementer instructions to whoever applies this draft. This
    // used to append "Add a visible <time> element... set datePublished/
    // dateModified..." as if that were prose; it shipped verbatim to a live
    // page (careers.njk, PR #50) instead of being read as a to-do.
    const today = new Date().toISOString().slice(0, 10);
    const content = {
      page,
      sections: [{
        heading: 'Last Updated',
        body: `This page was last updated on ${today}.`,
      }],
      focus,
    };
    return { content, summary: `Freshness-date section for ${page}: dateModified ${today}` };
  }

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
    sections = await callLLMForJson(system, user, {
      maxTokens: 900, generatorId: meta.id, siteId, validate: Array.isArray,
    });
  } catch {
    throw Object.assign(new Error('Content expansion failed: model did not return valid JSON'), { status: 400, userFacing: true });
  }
  sections = sections
    .filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string')
    .slice(0, 4)
    .map((s) => ({ ...s, table: sanitizeTable(s.table) }));

  const content = { page, sections, focus: focus || 'general' };
  const focusLabel = focus ? ` (${focus})` : '';
  return { content, summary: `${sections.length} expanded section(s) for ${page}${focusLabel}` };
}
