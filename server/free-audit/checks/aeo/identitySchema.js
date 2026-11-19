import { parseJsonLdBlocks, typesOf } from '../jsonLd.js';

const IDENTITY_TYPES = ['Organization', 'Person', 'LocalBusiness', 'Corporation'];

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
const urlsIn = (v) => []
  .concat(v || [])
  .map((x) => (typeof x === 'string' ? x : x?.url))
  .filter((x) => hasText(x) && /^https?:\/\//i.test(x) && !/REPLACE/i.test(x));

// A name alone does not tell an AI engine WHICH organisation this is. The links to the brand's
// other profiles (sameAs) are what let it recognise the entity and name it correctly.
export default function identitySchema({ $ }) {
  const blocks = parseJsonLdBlocks($);
  const identityBlock = blocks.find(
    (b) => typesOf(b).some((t) => IDENTITY_TYPES.includes(t)) && hasText(b.name)
  );

  if (!identityBlock) {
    return {
      id: 'identity-schema',
      title: 'Identity Schema',
      category: 'aeo',
      passed: false,
      score: 0,
      maxScore: 6,
      message: 'No Organization/Person/LocalBusiness schema with a name found.',
      recommendation: 'Add Organization or Person JSON-LD schema so LLMs and search engines can identify your brand.',
    };
  }

  const hasUrl = urlsIn(identityBlock.url).length > 0;
  const hasSameAs = urlsIn(identityBlock.sameAs).length > 0;
  const hasLogo = urlsIn(identityBlock.logo).length > 0;
  const hasId = hasText(identityBlock['@id']);

  // name 3 + url 1 + sameAs 1 + logo 1 = 6 (maxScore unchanged)
  const score = 3 + (hasUrl ? 1 : 0) + (hasSameAs ? 1 : 0) + (hasLogo ? 1 : 0);
  const missing = [
    !hasUrl && 'url',
    !hasSameAs && 'sameAs (links to your LinkedIn, X, Google Business, Wikipedia or similar profiles)',
    !hasLogo && 'logo',
    !hasId && '@id (a stable identifier other schema blocks can point to)',
  ].filter(Boolean);
  const complete = hasUrl && hasSameAs && hasLogo;
  const label = `${typesOf(identityBlock).join(', ')}: "${identityBlock.name}"`;

  return {
    id: 'identity-schema',
    title: 'Identity Schema',
    category: 'aeo',
    passed: hasSameAs,
    score,
    maxScore: 6,
    message: complete
      ? `Identity schema found with url, logo and sameAs (${label}).`
      : `Identity schema found (${label}) but missing: ${missing.join(', ')}.`,
    recommendation: complete
      ? 'No action needed.'
      : `Add ${missing.filter((m) => !m.startsWith('@id')).join(', ') || 'an @id'} to the schema so AI engines can tell who you are and name you correctly.`,
  };
};
