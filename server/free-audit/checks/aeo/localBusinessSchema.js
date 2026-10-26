import { parseJsonLdBlocks, typesOf } from '../jsonLd.js';

export default function localBusinessSchema({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const block = blocks.find((b) => typesOf(b).some((t) => t === 'LocalBusiness' || t.endsWith('LocalBusiness')));

  if (!block) {
    return {
      id: 'local-business-schema',
      title: 'Local Business Schema',
      category: 'aeo',
      passed: false,
      score: 0,
      maxScore: 5,
      message: 'No LocalBusiness JSON-LD schema found.',
      recommendation:
        'If this is a local business, add LocalBusiness schema with name, address, and telephone so AI assistants and search engines can surface your location details.',
    };
  }

  const hasAddress = !!block.address;
  const hasPhone = !!block.telephone;
  const count = [hasAddress, hasPhone].filter(Boolean).length;

  return {
    id: 'local-business-schema',
    title: 'Local Business Schema',
    category: 'aeo',
    passed: count === 2,
    score: 1 + count * 2,
    maxScore: 5,
    message: `LocalBusiness schema found${hasAddress ? ' with address' : ' (missing address)'}${
      hasPhone ? ' and telephone' : ' (missing telephone)'
    }.`,
    recommendation: count === 2 ? 'No action needed.' : 'Add address and telephone fields to your LocalBusiness schema.',
  };
};
