import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'schema',
  name: 'Schema Markup Generator',
  description: 'Drafts JSON-LD structured data for a page, populated only from fields verifiable in the real page content.',
  recommendationTags: ['Add schema', 'Missing schema'],
};

const ALLOWED_TYPES = ['Article', 'Product', 'Organization', 'LocalBusiness', 'HowTo', 'BreadcrumbList'];
const PLACEHOLDER_NOTE = '[NEEDS INPUT — not found on the page]';

// params: { page: string, schemaType: string }
export async function generate({ params }) {
  const { page, schemaType } = params;
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });
  if (!ALLOWED_TYPES.includes(schemaType)) {
    throw Object.assign(new Error(`schemaType must be one of: ${ALLOWED_TYPES.join(', ')}`), { status: 400 });
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
  const placeholderFields = [];
  (function scan(node, path) {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) scan(v, path ? `${path}.${k}` : k);
    } else if (node === PLACEHOLDER_NOTE) {
      placeholderFields.push(path);
    }
  })(jsonLd, '');

  const content = { page, schemaType, jsonLd, placeholderFields };
  return {
    content,
    summary: `${schemaType} schema for ${page}` + (placeholderFields.length ? ` (${placeholderFields.length} field(s) need manual input)` : ''),
  };
}
