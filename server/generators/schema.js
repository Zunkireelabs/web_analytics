import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'schema',
  name: 'Schema Markup Generator',
  description: 'Drafts JSON-LD structured data for a page, populated only from fields verifiable in the real page content.',
  recommendationTags: ['Add schema', 'Missing schema'],
};

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

// Types whose entire meaning depends on facts a generic content page (no
// real reviews/products/events on it) essentially never has — unlike a
// plain Article (headline/body/date, always derivable from any real page),
// drafting one of these when its DEFINING facts are unverifiable produces a
// technically-valid but practically unusable, unapprovable JSON-LD block.
// inferSchemaType() (page-content.js) deliberately trusts ANY existing
// @type already on the page, even a stale/boilerplate one with no real
// data behind it — so without this guard, a page that's genuinely just an
// article (but happens to carry a leftover/misconfigured "Review" type)
// would keep getting offered the same unusable Review draft on every
// audit run forever. Listed here as the field path(s) that must resolve to
// real content for the type to mean anything; if ALL of them come back as
// placeholders, the type inference itself was wrong for this page, not
// just one optional field — fall back to Article instead.
const RISKY_TYPE_CORE_FIELDS = {
  Review: ['author.name', 'reviewer.name', 'reviewRating.ratingValue'],
  AggregateRating: ['ratingValue', 'reviewCount'],
  Product: ['offers.price'],
  Recipe: ['recipeIngredient'],
  Event: ['startDate', 'location.name'],
  JobPosting: ['datePosted', 'hiringOrganization.name'],
};

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

// True when `schemaType` is a risky type AND every one of its defining
// facts came back unresolved — the type inference itself was wrong for
// this page, not just one optional field left blank.
export function needsArticleFallback(schemaType, placeholderFields) {
  const coreFields = RISKY_TYPE_CORE_FIELDS[schemaType];
  return !!coreFields && schemaType !== 'Article' && coreFields.every((f) => placeholderFields.includes(f));
}

async function draftJsonLd(schemaType, title, bodyText) {
  const system = `You are a structured-data specialist. Draft valid schema.org JSON-LD of type "${schemaType}" ` +
    'for a real page, using ONLY its real title and body text given below. Populate a field ONLY if its value ' +
    `is actually present in that text. For any schema-required field you cannot verify from the text, set its ` +
    `value to the exact literal string "${PLACEHOLDER_NOTE}" — never invent a plausible-looking price, rating, ` +
    'date, or other fact that is not actually in the text. Respond with ONLY the JSON-LD object (include ' +
    '"@context": "https://schema.org" and the correct "@type").';
  const user = `Page title: ${title}\nPage text: ${bodyText.slice(0, 3000)}`;
  const raw = await callLLM(system, user, { maxTokens: 700 });
  try {
    return JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error('Schema generation failed: model did not return valid JSON'), { status: 400 });
  }
}

// params: { page: string, schemaType: string }
export async function generate({ params }) {
  const { page, schemaType } = params;
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  if (!schemaType || !SCHEMA_TYPE_RE.test(schemaType)) {
    throw Object.assign(new Error('schemaType must be a valid schema.org type name'), { status: 400 });
  }

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
  const { title, bodyText } = fetched.analysis;

  let effectiveType = schemaType;
  let jsonLd = await draftJsonLd(effectiveType, title, bodyText);
  let placeholderFields = resolvePlaceholders(jsonLd);

  if (needsArticleFallback(schemaType, placeholderFields)) {
    effectiveType = 'Article';
    jsonLd = await draftJsonLd(effectiveType, title, bodyText);
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
