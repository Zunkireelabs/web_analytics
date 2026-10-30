import { parseJsonLdBlocks, typesOf } from '../jsonLd.js';

const RICH_TYPES = ['FAQPage', 'HowTo', 'Article', 'Product', 'Recipe', 'Event'];

export default function structuredDataRich({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const found = blocks
    .flatMap((b) => typesOf(b))
    .filter((t) => RICH_TYPES.includes(t));
  const unique = [...new Set(found)];

  return {
    id: 'rich-structured-data',
    title: 'Rich Structured Data',
    category: 'aeo',
    passed: unique.length > 0 ? true : null,
    score: unique.length > 0 ? 3 : 0,
    maxScore: unique.length > 0 ? 3 : 0,
    message:
      unique.length > 0
        ? `Rich content schema found: ${unique.join(', ')}.`
        : 'No FAQPage/HowTo/Article/Product schema found (not required for all pages).',
    recommendation:
      unique.length > 0
        ? 'No action needed.'
        : 'Consider adding FAQPage, HowTo, or Article schema where relevant — these are commonly extracted for direct answers by AI systems.',
  };
};
