import { analyzePageUrl, requireGroundedContent } from '../agents/lib/page-content.js';
import { getSiteById } from '../store/read.js';
import { callLLMForJson } from '../llm.js';
import { groundingProviderConfigured, searchGroundedSources, queryTokens } from '../ingest/search-grounding-providers/index.js';
import { safeMessage } from '../lib/errors.js';
import { filterCompetitorCandidates } from '../agents/lib/competitor-policy.js';
import { attributionNote } from '../agents/lib/zunkireelabs-growth-policy.js';
import { checkExpandContentStructuralFit } from './lib/expand-content-structural-fit.js';
import { tenantContextTextFor } from '../lib/tenant-context.js';
import { loadExpandStructurePrior } from '../design-agent/lib/expand-structure-loader.js';
import { structurePlanText } from '../design-agent/lib/expand-structure-spec.js';
import { classifyPageType } from '../design-agent/live-analysis/schema.js';

// Real citation search is opt-in, separate from TAVILY_API_KEY simply being
// set — citation search would silently start spending Tavily's quota the
// moment the key existed, without this explicit switch. Tavily is the sole
// search-grounding provider (search-grounding-providers/index.js) —
// deliberately never Google CSE or SerpApi, which stay reserved for real
// SEO/SERP/keyword-demand intelligence in competitor-providers/.
const CITATION_SEARCH_ENABLED = process.env.ENABLE_CONTENT_CITATION_SEARCH === 'true';

// Final number of citation candidates handed to the model. Fetched count is
// larger (capped at Tavily's own max of 10) so that filtering out this
// site's configured competitors (see the external-citations branch below)
// doesn't leave fewer than CITATION_COUNT legitimate sources when a
// competitor happens to rank for the query.
const CITATION_COUNT = 3;
const CITATION_FETCH_COUNT = 8;

export const meta = {
  id: 'expand-content',
  name: 'Content Expansion Generator',
  description: 'Drafts additional body sections for an existing page, grounded in its real content. Supports focused expansions for GEO signals: comparison-content, external-citations. (author-byline and freshness-date are both retired — see the schema generator instead.)',
  recommendationTags: ['comparison-content', 'external-citations'],
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
// The example keys below are deliberately generic ("this_option"/
// "alternative") — an earlier version used a real brand name ("zunkiree_
// labs") as the example key, and the model copied that literal key/value
// verbatim into a live client page as a real table column header (PR #32,
// admizz-web-dev, 2026-09-15), instead of treating it as a placeholder shape
// to fill with THIS page's own real comparison. Never put any brand name —
// this platform's own or a client's — in a few-shot example key/value here.
const SYSTEM_COMPARISON = 'You are a content strategist. Given a page\'s real body text and target query, draft a comparison/alternatives section. ' +
  'Write 1-2 grounded lead-in sentences for "body", and — only if there are at least 2 real, meaningfully different points of comparison grounded ' +
  'in the page text — also include a "table" field: an array of plain objects, one per comparison row, every object using the exact same keys in the ' +
  'same order (e.g. [{"feature": "...", "this_option": "...", "alternative": "..."}, ...]). Every table VALUE must be a short plain string, never markdown or HTML. ' +
  'Do NOT invent specific competitor names, brand names, or features not in the page text — use placeholders with guidance, and omit "table" entirely rather than fabricate rows. ' +
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

// Safety net for SYSTEM_CITATIONS_GROUNDED's "exactly one section" instruction:
// the model can still return one section per source instead of one section
// covering all of them (this shipped to zunkireelabs' /about/ as three
// separate, visually-repeated "References" <h2> headings stacked down the
// page — a 2026-09-17 incident). Collapsing same-focus sections here means a
// prompt slip never reaches a live page, regardless of the model's
// compliance that run.
export function mergeCitationSections(sections) {
  if (sections.length <= 1) return sections;
  return [{
    heading: sections[0].heading,
    body: sections.map((s) => s.body).join('\n'),
    table: sections.find((s) => s.table)?.table,
  }];
}

// Used when real search results are available for the external-citations focus
// (see CITATION_SEARCH_ENABLED below) — grounded in an actual candidate list
// the same way generators/internal-links.js grounds anchor suggestions in
// real on-site URLs, so the model is citing real pages, not inventing them.
const SYSTEM_CITATIONS_GROUNDED = 'You are a content strategist. Given a page\'s real body text and a list of REAL, already-verified ' +
  'source candidates (title + URL) provided below, draft ONE SINGLE external citations/references section covering ' +
  'ALL of them — never one section per source. ' +
  'Cite ONLY sources from that candidate list, using markdown links in the exact form [Source Title](URL) with the ' +
  'exact URL given — NEVER invent a URL and NEVER cite anything not in the list. If none of the candidates are ' +
  'actually relevant to the page topic, write the section without a link rather than forcing an irrelevant citation. ' +
  'Respond with ONLY a JSON array containing EXACTLY ONE object, its "body" a markdown bullet list ("- " per line) ' +
  'with one bullet per cited source: [{"heading": "References", "body": "- [Source Title](URL): one-sentence note\\n- ..."}]';

// Default path for external-citations: the references list is assembled
// directly from the verified search results — no model call. The model's only
// job on this path was to turn a list it was told to copy ("cite ONLY from
// this list, exact URLs") into bullets, and 29 pages of that is 29 paid calls
// for formatting. Relevance and trust are decided by rules instead: a result
// must share a meaningful word with the page's query/title, and is ranked
// ahead when it comes from an institutional or reference domain. Set
// CITATION_SECTION_MODE=llm to restore the written-notes version.
const CITATION_SECTION_MODE = process.env.CITATION_SECTION_MODE || 'deterministic';
const MIN_SOURCE_SCORE = 0.4;
// Company-directory / traffic-estimate / lead-database pages rank for almost
// any "X companies" query and are never a source worth citing (confirmed in a
// live sample: a RocketReach "competitors of <some training company>" page
// matched an "IT companies in Nepal" query on the words "IT" and "Nepal").
const LOW_VALUE_HOST_RE = /(^|\.)(rocketreach\.co|zoominfo\.com|similarweb\.com|owler\.com|craft\.co|apollo\.io|lusha\.com|cbinsights\.com|growjo\.com|tracxn\.com|pinterest\.[a-z.]+|quora\.com|reddit\.com)$/i;
const TRUSTED_HOST_RE = /(\.gov(\.[a-z]{2})?|\.edu(\.[a-z]{2})?|\.ac\.[a-z]{2}|\.org|wikipedia\.org|nature\.com|mckinsey\.com|gartner\.com|forrester\.com|oecd\.int|worldbank\.org)$/i;

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// A source is relevant when it shares at least one meaningful word with the
// page topic (query + title) in its own title or excerpt, and — when the
// provider supplies a relevance score — clears a floor. Both are conservative:
// dropping a good source costs one fewer bullet, keeping a bad one is a wrong
// citation on a live page.
export function isRelevantSource(source, topicTokens) {
  if (typeof source.score === 'number' && source.score < MIN_SOURCE_SCORE) return false;
  if (LOW_VALUE_HOST_RE.test(hostOf(source.url))) return false;
  const hay = queryTokens(`${source.title || ''} ${source.content || ''}`);
  // At least two topic words (or all of them for a one/two-word topic), so a
  // result matching only a generic word like "IT" or the country name is out.
  let hits = 0;
  for (const t of topicTokens) if (hay.has(t)) hits++;
  return hits >= Math.min(2, topicTokens.size) && hits > 0;
}

export function buildReferencesSections(sources, topicTokens, count = CITATION_COUNT) {
  const seenHosts = new Set();
  const picked = (sources || [])
    .filter((s) => s?.title && s?.url && /^https?:\/\//i.test(s.url) && isRelevantSource(s, topicTokens))
    .map((s) => ({ s, trusted: TRUSTED_HOST_RE.test(hostOf(s.url)) }))
    .sort((a, b) => Number(b.trusted) - Number(a.trusted))
    .map((x) => x.s)
    .filter((s) => { const h = hostOf(s.url); if (seenHosts.has(h)) return false; seenHosts.add(h); return true; })
    .slice(0, count);
  if (!picked.length) return [];
  const bullet = (s) => `- [${String(s.title).replace(/[\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim()}](${s.url}) — ${hostOf(s.url)}`;
  return [{ heading: 'References', body: picked.map(bullet).join('\n') }];
}

const FOCUS_SYSTEMS = {
  'comparison-content': SYSTEM_COMPARISON,
};

// params: { page: string, query?: string, focus?: string }
export async function generate({ siteId, params }) {
  const { page, query, focus } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400, userFacing: true });

  // Retired platform-wide (2026-09-24, explicit owner decision): an
  // "About the Author" section — whether a real configured individual
  // (authorByline) or the organization-name fallback (organizationByline)
  // — is no longer drafted for ANY site, regardless of require_visible_byline.
  // Previously the organization fallback bypassed require_visible_byline
  // entirely (see git history), so a site whose own policy said "no visible
  // byline" (require_visible_byline: false — the column's default, true for
  // every site that hasn't explicitly opted in) still got an unwanted
  // "About the Author: By the [Site Name] Team" section on every
  // expand-content run. Author EEAT signals still ship via schema.js's
  // Article-type author markup (Person or Organization) — this only retires
  // the VISIBLE section, same as before for a site with
  // require_visible_byline off. Checked before the page fetch below (unlike
  // every other focus): this refusal needs no page content at all, so there
  // is nothing to gain from fetching first.
  if (focus === 'author-byline') {
    throw Object.assign(
      new Error('Visible "About the Author" sections are retired platform-wide — author EEAT signals are handled by schema markup (schema.js) instead. Refusing to draft a visible byline section.'),
      { status: 400, userFacing: true },
    );
  }

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400, userFacing: true });
  requireGroundedContent(fetched.analysis, { generatorId: meta.id });

  if (focus === 'freshness-date') {
    // RETIRED 2026-09-20. This used to draft a VISIBLE "Last Updated"
    // heading + sentence as its own on-page EXPANDEDCONTENT section.
    // Confirmed live on site 8864 (chayceproperties.com, 2026-09-20): that
    // section shipped as an unclassed, unstyled <h1> on 6+ pages — exactly
    // the "flat, bolted-on generated content" failure CLAUDE.md's design-
    // preservation rule exists to prevent, on top of being a block nobody
    // asked to see on the page. The same real, honest freshness fact
    // (today's date) still reaches AI engines/Google via the 'schema'
    // generator's datePublished/dateModified JSON-LD (see geo-signals.js's
    // freshness-date rule, now routed there) — invisible structured data,
    // never visible prose. This focus refuses outright rather than drafting
    // anything, so no caller (manual UI, MCP tool, or an unattended chain)
    // can ever produce a visible "Last Updated" block again.
    throw Object.assign(
      new Error('The "freshness-date" focus is retired — it used to draft a VISIBLE "Last Updated" section, which broke design on ' +
        'live sites. Use the "schema" generator instead (datePublished/dateModified JSON-LD, invisible structured data).'),
      { status: 400, userFacing: true },
    );
  }

  // Structural pre-check BEFORE any LLM call — see expand-content-structural
  // -fit.js's header for the real incident this closes (116 abandoned drafts
  // on one site alone, each paying for a generation that could never be
  // inserted). Placed after the author-byline/freshness-date branches
  // above, which either need no repo access at all (freshness-date) or
  // already do their own site fetch (author-byline) — this only runs on the
  // path that actually needs to write free-form prose into the page. A null
  // result means the check itself couldn't run (no repo, no file mapping,
  // fetch failed) — proceeds unchanged, same as findRealFaqDataSource's
  // contract, so this never blocks a site this check simply cannot reach.
  const siteForStructuralCheck = await getSiteById(siteId);
  const structuralFit = await checkExpandContentStructuralFit(siteForStructuralCheck, page);
  if (structuralFit && !structuralFit.ok) {
    throw Object.assign(new Error(structuralFit.detail), { status: 400, userFacing: true });
  }

  let structurePrior = null;
  let system = focus && FOCUS_SYSTEMS[focus] ? FOCUS_SYSTEMS[focus] : SYSTEM_GENERAL;
  let user = `Query: ${query || ''}\nPage title: ${fetched.analysis.title}\nPage text: ${fetched.analysis.bodyText.slice(0, 3000)}`;

  // Same 2026-09-11 Zunkireelabs growth policy blog-outline.js's fresh posts
  // already carry (zunkireelabs-growth-policy.js) — a soft, contextual-only
  // instruction, never forced, applied here too so an expand-content section
  // on an EXISTING page can naturally mention Zunkireelabs when the page's
  // own topic genuinely touches web dev/SEO/AI/CRM/etc. Skipped for
  // external-citations below, which overwrites `system` entirely with a
  // grounded-sources-only prompt that must not carry any other instruction.
  if (focus !== 'external-citations') {
    const site = await getSiteById(siteId);
    system += attributionNote(site);
    // Expanded prose is written INTO an existing page, so the page's own text
    // is the primary grounding and stays first in `user`. The verified facts
    // are appended as a secondary source for the case the page excerpt is
    // thin — a product page that lists feature names with no explanation is
    // exactly where expansion is requested and exactly where the model has
    // least to work from. Deliberately not applied to external-citations,
    // whose prompt is replaced wholesale below and must carry no other
    // instruction.
    const tenantContext = await tenantContextTextFor(site, { sections: ['product'] });
    if (tenantContext) user += `\n\n${tenantContext}`;

    // Opt-in structure reference, expand-content ONLY (the loader asserts
    // that). Adds a section plan — how many sections, in what role order, no
    // table where the site draws none — to the prompt. Facts, wording,
    // citations and any table payload are untouched, and for a tenant that has
    // not opted in this is a no-op. The tenant's own page evidence wins per
    // field inside the prior.
    structurePrior = await loadExpandStructurePrior(site, {
      actionType: 'expand-content', pageType: classifyPageType(page, { propertyType: site?.property_type }),
    });
    const plan = structurePlanText(structurePrior);
    if (plan) user += `\n\n${plan}`;
  }

  // external-citations has no ungrounded mode: a citation is either backed
  // by a real, verified URL, or it doesn't get drafted at all — writing
  // "an editor should add the real source URL" as body prose (the previous
  // behavior) isn't a safe placeholder like schema.js's [NEEDS INPUT]
  // marker, it's indistinguishable published body text, and it shipped
  // straight to a live page. Fail honestly instead of drafting filler.
  let sourcesForSection = [];
  if (focus === 'external-citations') {
    if (!CITATION_SEARCH_ENABLED || !groundingProviderConfigured()) {
      throw Object.assign(new Error('External citations require real search grounding (ENABLE_CONTENT_CITATION_SEARCH + TAVILY_API_KEY) — refusing to draft an ungrounded citations section.'), { status: 400, userFacing: true, refusal: true, reason: 'citation-grounding-not-configured' });
    }
    let sources;
    try {
      // Fetch more than the final CITATION_COUNT so that removing this
      // site's own configured competitors (below) doesn't starve the
      // candidate list down to nothing — Tavily's adapter caps `num` at 10.
      const rawSources = await searchGroundedSources(query || fetched.analysis.title, CITATION_FETCH_COUNT);
      // Competitor URLs must never reach the model as citation candidates —
      // filtered here, BEFORE the prompt is built, not left for the model to
      // decide not to cite. Government/research/documentation/publication
      // sources are untouched; only a host matching this site's own active
      // competitor_profiles is removed. See agents/lib/competitor-policy.js.
      // The site's own pages are never a citation: a "source" that is the
      // page itself (confirmed in a live sample) or a sibling page is an
      // internal link, not external authority, and defeats the signal.
      const ownHost = hostOf(siteForStructuralCheck?.website_domain ? (/^https?:/.test(siteForStructuralCheck.website_domain) ? siteForStructuralCheck.website_domain : `https://${siteForStructuralCheck.website_domain}`) : page);
      const external = rawSources.filter((s) => { const h = hostOf(s.url); return h && ownHost && h !== ownHost && !h.endsWith(`.${ownHost}`); });
      const { allowed, removed } = await filterCompetitorCandidates(external, siteId);
      if (removed.length) {
        console.warn(`[expand-content] filtered ${removed.length} competitor source(s) from citation candidates for site ${siteId}: ${removed.map((s) => s.url).join(', ')}`);
      }
      sources = allowed.slice(0, CITATION_COUNT);
      sourcesForSection = allowed; // the no-LLM path filters for relevance itself, so it needs the wider competitor-free list
    } catch (err) {
      // Honest failure, not a system fault: Tavily being unavailable/out of
      // quota is an external-dependency state, not a bug in this code, so
      // this is marked `refusal: true` explicitly rather than relying on
      // the 400-499 status-range heuristic auto-remediation.js's isRefusal
      // otherwise infers status from — a non-4xx status here (e.g. a 502
      // gateway-style code) would otherwise get scored as a FAULT and could
      // trip the unattended run's circuit breaker for something that isn't
      // this generator's own failure. No retry here either: Tavily's own
      // adapter already applies its strict daily cap and maps quota/outage
      // errors distinctly (see search-grounding-providers/tavily.js) —
      // retrying here would just spend more of that same budget for no
      // better odds of success.
      const { message } = safeMessage('expand-content.searchSources', err, 'Citation search is temporarily unavailable — try again shortly, or draft this section without external citations.');
      throw Object.assign(new Error(message), { status: 400, userFacing: true, refusal: true, reason: 'citation-grounding-unavailable' });
    }
    if (!sources.length) {
      throw Object.assign(new Error('No real source candidates found for this page/query — refusing to draft an ungrounded citations section.'), { status: 400, userFacing: true, refusal: true, reason: 'citation-grounding-no-sources' });
    }
    system = SYSTEM_CITATIONS_GROUNDED;
    // `content` (Tavily's own extracted snippet, when present) gives the
    // model something to actually ground body prose in beyond a bare title
    // — without it, the LLM has no way to know a candidate is genuinely
    // relevant versus just plausibly-titled, and SYSTEM_CITATIONS_GROUNDED's
    // "omit the link rather than force an irrelevant citation" instruction
    // has no real signal to act on.
    user += `\n\nReal source candidates (cite ONLY from this list, using these exact URLs):\n` +
      sources.map((s) => `- ${s.title}: ${s.url}${s.content ? `\n  Excerpt: ${s.content}` : ''}`).join('\n');
  }

  let sections;
  if (focus === 'external-citations' && CITATION_SECTION_MODE !== 'llm') {
    // No model call: see buildReferencesSections. An empty result (nothing
    // relevant survived) falls through to the same honest refusal below.
    const topic = queryTokens(`${query || ''} ${fetched.analysis.title || ''}`);
    sections = buildReferencesSections(sourcesForSection, topic);
    if (!sections.length) {
      throw Object.assign(new Error('None of the real search results was relevant enough to cite for this page — refusing to draft a references section.'), { status: 400, userFacing: true, refusal: true, reason: 'citation-grounding-no-relevant-sources' });
    }
  } else try {
    sections = await callLLMForJson(system, user, {
      maxTokens: 1200, generatorId: meta.id, siteId, validate: Array.isArray,
    });
  } catch {
    throw Object.assign(new Error('Content expansion failed: model did not return valid JSON'), { status: 400, userFacing: true });
  }
  sections = sections
    .filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string')
    // 4 is the long-standing cap; a tenant's own structure can only tighten it.
    .slice(0, Math.min(4, structurePrior?.sectionCount?.max ?? 4))
    .map((s) => ({ ...s, table: sanitizeTable(s.table) }));

  if (focus === 'external-citations') sections = mergeCitationSections(sections);

  if (!sections.length) {
    // The empty-section quality-gate check only inspects sections that
    // exist — an empty array has none to flag, so `clean: true` would
    // otherwise let a zero-section draft persist and sit stuck forever.
    // Refuse here instead, same as the no-sources case above, so the
    // generator's normal retry/reject loop handles it.
    throw Object.assign(new Error('Content expansion produced no usable sections — the model returned an empty result or nothing matched the expected shape.'), { status: 400, userFacing: true, refusal: true, reason: 'expand-content-empty-sections' });
  }

  const content = { page, sections, focus: focus || 'general' };
  const focusLabel = focus ? ` (${focus})` : '';
  return { content, summary: `${sections.length} expanded section(s) for ${page}${focusLabel}` };
}
