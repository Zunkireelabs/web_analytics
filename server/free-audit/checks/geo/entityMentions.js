import { parseJsonLdBlocks, typesOf } from '../jsonLd.js';

const ENTITY_TYPES = ['Organization', 'Person', 'Product', 'LocalBusiness', 'Place', 'Event'];

export default function entityMentions({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const hasEntitySchema = blocks.some((b) => {
    const t = typesOf(b);
    return t.some((type) => ENTITY_TYPES.includes(type));
  });

  const bodyText = $('body').text().toLowerCase();
  const entityKeywords = ['organization', 'company', 'person', 'product', 'business', 'service', 'team', 'founder', 'ceo', 'founders'];
  const foundKeywords = entityKeywords.filter((kw) => bodyText.includes(kw));
  const hasEntityMentions = foundKeywords.length >= 2;

  const found = hasEntitySchema || hasEntityMentions;

  let score;
  if (hasEntitySchema && hasEntityMentions) score = 10;
  else if (hasEntitySchema || hasEntityMentions) score = 5;
  else score = 0;

  return {
    id: 'entity-mentions',
    title: 'Entity Mentions & Schema',
    category: 'geo',
    passed: found,
    score,
    maxScore: 10,
    message: hasEntitySchema && hasEntityMentions
      ? 'Entity schema and entity mentions found — AI engines can identify what the page is about.'
      : hasEntitySchema
      ? 'Entity schema found but no entity mentions in body text — add natural references to your organization, product, or people.'
      : hasEntityMentions
      ? 'Entity mentions found in body text but no entity schema — add Organization, Product, or Person JSON-LD.'
      : 'No entity schema or entity mentions found — AI engines cannot identify what the page is about.',
    recommendation: hasEntitySchema && hasEntityMentions
      ? 'No action needed.'
      : 'Add entity schema (Organization, Product, Person) and mention entities naturally in your body content.',
  };
};
