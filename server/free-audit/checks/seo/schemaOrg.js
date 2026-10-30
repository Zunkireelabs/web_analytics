import { parseJsonLdBlocks } from '../jsonLd.js';

export default function schemaOrg({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const found = blocks.length > 0;

  return {
    id: 'schema-org',
    title: 'Schema.org Structured Data',
    category: 'seo',
    passed: found,
    score: found ? 5 : 0,
    maxScore: 5,
    message: found ? `${blocks.length} valid JSON-LD block(s) found.` : 'No valid Schema.org JSON-LD found.',
    recommendation: found ? 'No action needed.' : 'Add Schema.org structured data (JSON-LD) relevant to your content.',
  };
};
