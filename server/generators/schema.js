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

  const system = `You are a structured-data specialist. Draft valid schema.org JSON-LD of type "${schemaType}" ` +
    'for a real page, using ONLY its real title and body text given below. Populate a field ONLY if its value ' +
    `is actually present in that text. For any schema-required field you cannot verify from the text, set its ` +
    `value to the exact literal string "${PLACEHOLDER_NOTE}" — never invent a plausible-looking price, rating, ` +
    'date, or other fact that is not actually in the text. Respond with ONLY the JSON-LD object (include ' +
    '"@context": "https://schema.org" and the correct "@type").';
  const user = `Page title: ${title}\nPage text: ${bodyText.slice(0, 3000)}`;
  const raw = await callLLM(system, user, { maxTokens: 700 });

  let jsonLd;
  try {
    jsonLd = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Object.assign(new Error('Schema generation failed: model did not return valid JSON'), { status: 400 });
  }

  // Recursive — placeholders often land inside nested objects (e.g.
  // address.addressRegion, contactPoint.email), not just top-level fields.
  // Date fields get auto-filled in place (today's date) rather than added
  // to placeholderFields, so a missing date alone no longer blocks bulk
  // publish — see DATE_FIELD_RE above.
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

  const content = { page, schemaType, jsonLd, placeholderFields };
  return {
    content,
    summary: `${schemaType} schema for ${page}` + (placeholderFields.length ? ` (${placeholderFields.length} field(s) need manual input)` : ''),
  };
}
