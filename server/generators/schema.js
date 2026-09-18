import { analyzePageUrl, requireGroundedContent } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { getSiteById } from '../store/read.js';
import { hasAuthorProfile, authorJsonLd } from './lib/author-profile.js';

export const meta = {
  id: 'schema',
  name: 'Schema Markup Generator',
  description: 'Drafts JSON-LD structured data for a page, populated only from fields verifiable in the real page content, plus the site\'s real configured author for Article-like types.',
  recommendationTags: ['Add schema', 'Missing schema'],
};

// EEAT — the site's own configured author (sites.author_name, migration 090)
// is a real, staff-confirmed fact, unlike price/rating/other page-specific
// facts, so it's always safe to populate for the article-shaped types where
// Google's guidelines actually look for an author. Never applied to
// Product/Organization/etc. — an "author" on those types isn't a real
// schema.org concept in the same sense.
const ARTICLE_LIKE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle']);

// inferSchemaType() (page-content.js) deliberately passes through whatever
// real @type is already on the page (e.g. "EducationalOrganization",
// "Course") when one exists — it's not limited to its own URL-hint list, so
// a fixed enum here can never stay in sync with it. Just sanity-check the
// shape of a schema.org type name (PascalCase word, optionally dotted for
// nested types like "schema:Product") to guard against garbage/injected
// params, without rejecting legitimate real-page values.
const SCHEMA_TYPE_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const PLACEHOLDER_NOTE = '[NEEDS INPUT — not found on the page]';

// Unlike price/rating/other facts (which stay blocked as genuinely
// unverifiable — guessing those would be fabrication), a missing
// datePublished/dateModified is safe to default to today: it's the actual,
// true date this schema is being published, not a guess about the page's
// real history. Same convention as sitemap.js/newpage-render.js's own
// date defaults. Matched by trailing field name so it also catches nested
// paths like "review.datePublished".
const DATE_FIELD_RE = /(?:^|\.)(datePublished|dateModified|dateCreated)$/i;

// Recursive placeholder scan — pure, shared by the two generation attempts
// below (initial type, and the Article fallback if that type turns out
// unusable). Placeholders land inside nested objects (e.g. author.name,
// reviewRating.ratingValue), not just top-level fields. Date fields get
// auto-filled in place (today's real publish date, not a guess about page
// history) rather than counted as a placeholder — same convention as
// sitemap.js/newpage-render.js's own date defaults.
export function resolvePlaceholders(jsonLd) {
  const today = new Date().toISOString().slice(0, 10);
  const placeholderFields = [];
  (function scan(node, path, parent, key) {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) scan(v, path ? `${path}.${k}` : k, node, k);
    } else if (node === PLACEHOLDER_NOTE) {
      if (DATE_FIELD_RE.test(path)) parent[key] = today;
      else placeholderFields.push(path);
    }
  })(jsonLd, '', null, null);
  return placeholderFields;
}

// General, type-agnostic rule — no per-type "which fields matter" list to
// keep in sync (a hardcoded list can only ever cover the types someone
// thought to name, and silently misses every other type the same bug can
// hit). Grounded in a fact true for every type, not a guess about any one
// of them: a schema draft with ANY unresolved placeholder already can't
// auto-publish (marker-merge.js's buildMergeValues blocks it outright,
// whatever the type), so there is no upside to keeping a "better-fitting
// but broken" non-Article type over Article — the one type that's reliably
// fully groundable from real page title/body text alone, since every real
// page has both. inferSchemaType() (page-content.js) deliberately trusts
// ANY existing @type already on the page, even a stale/boilerplate one with
// no real data behind it, so without this fallback a page carrying a
// leftover/misconfigured type would keep getting offered the same unusable
// draft on every future audit run, for whichever type it happened to be.
export function needsArticleFallback(schemaType, placeholderFields) {
  return schemaType !== 'Article' && placeholderFields.length > 0;
}

async function draftJsonLd(schemaType, title, bodyText, siteId) {
  const system = `You are a structured-data specialist. Draft valid schema.org JSON-LD of type "${schemaType}" ` +
    'for a real page, using ONLY its real title and body text given below. Populate a field ONLY if its value ' +
    `is actually present in that text. For any schema-required field you cannot verify from the text, set its ` +
    `value to the exact literal string "${PLACEHOLDER_NOTE}" — never invent a plausible-looking price, rating, ` +
    'date, or other fact that is not actually in the text. Respond with ONLY the JSON-LD object (include ' +
    '"@context": "https://schema.org" and the correct "@type").';
  const user = `Page title: ${title}\nPage text: ${bodyText.slice(0, 3000)}`;
  try {
    return await callLLMForJson(system, user, { maxTokens: 800, generatorId: meta.id, siteId });
  } catch {
    throw Object.assign(new Error('Schema generation failed: model did not return valid JSON'), { status: 400 });
  }
}

// params: { page: string, schemaType: string }
export async function generate({ siteId, params }) {
  const { page, schemaType } = params;
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  if (!schemaType || !SCHEMA_TYPE_RE.test(schemaType)) {
    throw Object.assign(new Error('schemaType must be a valid schema.org type name'), { status: 400 });
  }

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
  requireGroundedContent(fetched.analysis, { generatorId: meta.id });
  const { title, bodyText, schemaTypes: existingSchemaTypes } = fetched.analysis;

  // The page already carries real schema of this exact type — drafting
  // another one would produce a second, duplicate JSON-LD block describing
  // the same entity rather than filling a real gap (schema is only ever
  // recommended for pages page-content.js/technical-seo.js found with NO
  // schema at all, but this generator can also be triggered manually or
  // against stale recommendation state, so it re-checks live rather than
  // trusting the caller). Fail outright — regenerating the LLM call can't
  // change the fact the type is already there.
  if (existingSchemaTypes.includes(schemaType)) {
    // stale: true — this isn't a case the generator can't handle, it's proof
    // the recommendation's own premise (no schema of this type) is no longer
    // true. Left as an ordinary refusal, this recommendation stays 'open' and
    // gets re-attempted (and re-refused) by every future run forever — see
    // auto-remediation.js's stale-refusal handling, which closes it instead.
    throw Object.assign(
      new Error(`This page already has real "${schemaType}" schema — drafting another would duplicate it, not fix a gap.`),
      { status: 400, userFacing: true, refusal: true, stale: true },
    );
  }

  const site = await getSiteById(siteId);

  let effectiveType = schemaType;
  let jsonLd = await draftJsonLd(effectiveType, title, bodyText, siteId);
  if (ARTICLE_LIKE_TYPES.has(effectiveType) && hasAuthorProfile(site)) jsonLd.author = authorJsonLd(site);
  let placeholderFields = resolvePlaceholders(jsonLd);

  if (needsArticleFallback(schemaType, placeholderFields)) {
    if (existingSchemaTypes.includes('Article')) {
      throw Object.assign(
        new Error(`"${schemaType}" schema had no real data on the page, and the Article fallback would duplicate the page's existing real Article schema — refusing to draft either.`),
        { status: 400, userFacing: true },
      );
    }
    effectiveType = 'Article';
    jsonLd = await draftJsonLd(effectiveType, title, bodyText, siteId);
    if (hasAuthorProfile(site)) jsonLd.author = authorJsonLd(site);
    placeholderFields = resolvePlaceholders(jsonLd);
  }

  const content = { page, schemaType: effectiveType, jsonLd, placeholderFields };
  if (effectiveType !== schemaType) content.typeFallbackFrom = schemaType;
  return {
    content,
    summary: `${effectiveType} schema for ${page}` +
      (effectiveType !== schemaType ? ` (${schemaType} had no real data on the page — used Article instead)` : '') +
      (placeholderFields.length ? ` (${placeholderFields.length} field(s) need manual input)` : ''),
  };
}
