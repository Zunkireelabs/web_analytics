// Lightweight structural validation for generator-produced JSON-LD — catches
// malformed/incomplete structured data before it publishes. Deliberately not
// a full schema.org vocabulary validator (that's a much bigger, ongoing
// maintenance burden with its own drift risk); checks the handful of things
// that make published JSON-LD actually useless to a search engine: a
// missing @context/@type, or a missing field Google's own structured-data
// guidelines treat as required for that specific @type. schema.js's
// PLACEHOLDER_NOTE/placeholderFields convention already blocks publish on
// any field the LLM couldn't verify — this is a separate, structural check
// that runs regardless of whether every field is filled in: a required
// field can be missing entirely (never emitted at all) without ever being a
// placeholder string.

const REQUIRED_FIELDS_BY_TYPE = {
  Article: ['headline'],
  BlogPosting: ['headline'],
  NewsArticle: ['headline'],
  Product: ['name'],
  FAQPage: ['mainEntity'],
  Organization: ['name'],
  LocalBusiness: ['name'],
  BreadcrumbList: ['itemListElement'],
};

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function validateBlock(jsonLd, path, issues) {
  if (!jsonLd || typeof jsonLd !== 'object') return;
  if (!jsonLd['@context'] || !String(jsonLd['@context']).includes('schema.org')) {
    issues.push({ path: `${path}.@context`, patternId: 'schema-missing-context', snippet: 'JSON-LD block is missing "@context": "https://schema.org"' });
  }
  const type = jsonLd['@type'];
  if (!type) {
    issues.push({ path: `${path}.@type`, patternId: 'schema-missing-type', snippet: 'JSON-LD block is missing "@type"' });
    return;
  }
  for (const field of REQUIRED_FIELDS_BY_TYPE[type] || []) {
    if (isEmpty(jsonLd[field])) {
      issues.push({ path: `${path}.${field}`, patternId: 'schema-missing-required-field', snippet: `${type} schema is missing required field "${field}"` });
    }
  }
}

// Every schema-producing generator today (schema.js, faq.js) puts its
// JSON-LD under one of these two conventional field names — new generators
// should follow the same convention rather than inventing a third, so they
// pick up this check for free.
const JSONLD_FIELD_NAMES = ['jsonLd', 'schemaJsonLd'];

export function findSchemaIssues(content) {
  const issues = [];
  if (!content || typeof content !== 'object') return issues;
  for (const field of JSONLD_FIELD_NAMES) {
    if (content[field] !== undefined) validateBlock(content[field], field, issues);
  }
  return issues;
}
