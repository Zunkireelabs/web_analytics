import { parseJsonLdBlocks } from '../jsonLd.js';

export default function freshnessSignals({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const hasSchemaDate = blocks.some((b) => !!b.datePublished || !!b.dateModified);
  const hasMetaDate =
    $('meta[property="article:published_time"]').length > 0 ||
    $('meta[property="article:modified_time"]').length > 0;
  const hasTimeTag = $('time[datetime]').length > 0;

  const hasSchemaDateTime = hasSchemaDate && (hasMetaDate || hasTimeTag);
  const hasAnyDate = hasSchemaDate || hasMetaDate || hasTimeTag;

  let score;
  if (hasSchemaDateTime) score = 10;
  else if (hasAnyDate) score = 5;
  else score = 0;

  const found = hasAnyDate;

  return {
    id: 'freshness-signals',
    title: 'Freshness Signals',
    category: 'geo',
    passed: found,
    score,
    maxScore: 10,
    message: found
      ? 'Publish/update date signals found — generative engines favor recently-updated content when choosing what to cite.'
      : 'No publish or last-updated date found (no datePublished/dateModified schema, article meta tags, or <time> element).',
    recommendation: found
      ? 'No action needed.'
      : 'Expose a publish or last-updated date via datePublished/dateModified schema, article:modified_time meta tags, or a visible <time> element.',
  };
};
