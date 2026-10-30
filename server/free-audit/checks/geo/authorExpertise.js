import { parseJsonLdBlocks } from '../jsonLd.js';

export default function authorExpertise({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const hasSchemaAuthor = blocks.some((b) => {
    if (!b.author) return false;
    if (typeof b.author === 'string') return b.author.trim().length > 0;
    if (Array.isArray(b.author)) return b.author.some((a) => a && (a.name || typeof a === 'string'));
    return !!b.author.name;
  });

  const hasBylineMarkup =
    $('[rel="author"]').length > 0 ||
    $('[itemprop="author"]').length > 0 ||
    $('meta[name="author"]').length > 0 ||
    $('.author, .byline, [class*="author-"], [class*="writer"], [class*="contributor"]').length > 0;

  const hasVisibleByline = hasBylineMarkup && !hasSchemaAuthor;

  let score;
  if (hasSchemaAuthor) score = 10;
  else if (hasVisibleByline) score = 5;
  else score = 0;

  const found = hasSchemaAuthor || hasBylineMarkup;

  return {
    id: 'author-expertise',
    title: 'Author & Expertise Signals',
    category: 'geo',
    passed: found,
    score,
    maxScore: 10,
    message: found
      ? 'Author/byline signals found — attributed content is more trusted and more likely to be cited by AI.'
      : 'No author or byline signals found (no author schema, rel="author", itemprop="author", or visible byline).',
    recommendation: found
      ? 'No action needed.'
      : 'Attribute content to a named author (schema author field or a visible byline). Unattributed content is less likely to be cited by generative engines.',
  };
};
