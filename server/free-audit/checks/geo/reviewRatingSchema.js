import { parseJsonLdBlocks, typesOf } from '../jsonLd.js';

function hasNestedAggregateRating(block) {
  const rating = block && block.aggregateRating;
  if (!rating || typeof rating !== 'object') return false;
  return typesOf(rating).some((t) => t === 'AggregateRating') || (!!rating.ratingValue && !!rating.reviewCount);
}

export default function reviewRatingSchema({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const hasReviewType = blocks.some((b) => typesOf(b).some((t) => t === 'Review' || t === 'AggregateRating'));
  const hasNested = blocks.some(hasNestedAggregateRating);
  const hasSchemaRating = hasReviewType || hasNested;

  const hasVisibleStars = $('.star-rating, .rating, [class*="stars"], [class*="rating"]').length > 0;
  const hasRatingMeta = $('meta[itemprop="ratingValue"]').length > 0;

  let score;
  if (hasSchemaRating) score = 10;
  else if (hasVisibleStars || hasRatingMeta) score = 5;
  else score = 0;

  const found = hasSchemaRating || hasVisibleStars || hasRatingMeta;

  return {
    id: 'review-rating-schema',
    title: 'Review & Rating Schema',
    category: 'geo',
    passed: found,
    score,
    maxScore: 10,
    message: found
      ? 'Review or AggregateRating schema found — social proof AI can surface when recommending this brand.'
      : 'No Review or AggregateRating schema found.',
    recommendation: found
      ? 'No action needed.'
      : 'Add Review or AggregateRating JSON-LD (or nest aggregateRating inside your Product/LocalBusiness schema) so AI assistants can cite social proof when comparing options.',
  };
};
