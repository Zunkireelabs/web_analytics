import { parseJsonLdBlocks, typesOf } from '../jsonLd.js';
import { validateBlock } from '../../schemaRules.js';

const RICH_TYPES = ['FAQPage', 'HowTo', 'Article', 'NewsArticle', 'BlogPosting', 'Product', 'Recipe', 'Event'];

export default function structuredDataRich({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const richBlocks = blocks.filter((b) => typesOf(b).some((t) => RICH_TYPES.includes(t)));
  const unique = [...new Set(richBlocks.flatMap((b) => typesOf(b)).filter((t) => RICH_TYPES.includes(t)))];

  if (unique.length === 0) {
    return {
      id: 'rich-structured-data',
      title: 'Rich Structured Data',
      category: 'aeo',
      passed: null,
      score: 0,
      maxScore: 0,
      message: 'No FAQPage/HowTo/Article/Product schema found (not required for all pages).',
      recommendation:
        'Consider adding FAQPage, HowTo, or Article schema where relevant — these are commonly extracted for direct answers by AI systems.',
    };
  }

  // Present is not enough: a block with required properties missing is ignored by search and answer engines.
  const invalid = richBlocks
    .flatMap((b) => validateBlock(b))
    .filter((f) => RICH_TYPES.includes(f.type) && f.missingRequired.length > 0);

  if (invalid.length === 0) {
    return {
      id: 'rich-structured-data',
      title: 'Rich Structured Data',
      category: 'aeo',
      passed: true,
      score: 3,
      maxScore: 3,
      message: `Rich content schema found with its required properties: ${unique.join(', ')}.`,
      recommendation: 'No action needed.',
    };
  }

  const detail = invalid.map((f) => `${f.type} is missing ${f.missingRequired.join(', ')}`).join('; ');
  return {
    id: 'rich-structured-data',
    title: 'Rich Structured Data',
    category: 'aeo',
    passed: false,
    score: 1,
    maxScore: 3,
    message: `Rich content schema found (${unique.join(', ')}) but incomplete: ${detail}.`,
    recommendation: 'Fill in the missing required properties — schema without them is ignored by search and AI answer engines.',
  };
};
