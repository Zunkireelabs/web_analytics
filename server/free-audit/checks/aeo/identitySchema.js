import { parseJsonLdBlocks, typesOf } from '../jsonLd.js';

const IDENTITY_TYPES = ['Organization', 'Person', 'LocalBusiness', 'Corporation'];

export default function identitySchema({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const identityBlock = blocks.find(
    (b) => typesOf(b).some((t) => IDENTITY_TYPES.includes(t)) && !!b.name
  );

  return {
    id: 'identity-schema',
    title: 'Identity Schema',
    category: 'aeo',
    passed: !!identityBlock,
    score: identityBlock ? 6 : 0,
    maxScore: 6,
    message: identityBlock
      ? `Identity schema found (${typesOf(identityBlock).join(', ')}: "${identityBlock.name}").`
      : 'No Organization/Person/LocalBusiness schema with a name found.',
    recommendation: identityBlock
      ? 'No action needed.'
      : 'Add Organization or Person JSON-LD schema so LLMs and search engines can identify your brand.',
  };
};
