// Required-property rules for the schema.org types a page is most likely to ship.
//
// Having a block of the right @type is not enough: a FAQPage with no questions, or a Product with no
// name/offer, is ignored by search and answer engines. This reports what is missing, per block.
//
// Sources: Google Search Central structured-data documentation for each type (required vs recommended).
// `anyOf` means "at least one of these groups must be present".

const RULES = {
  FAQPage: { required: ['mainEntity'], custom: 'faq' },
  HowTo: { required: ['name', 'step'], recommended: ['image', 'totalTime'] },
  Article: { required: ['headline'], recommended: ['author', 'datePublished', 'image'] },
  NewsArticle: { required: ['headline'], recommended: ['author', 'datePublished', 'image'] },
  BlogPosting: { required: ['headline'], recommended: ['author', 'datePublished', 'image'] },
  Product: { required: ['name'], anyOf: [['offers', 'review', 'aggregateRating']], recommended: ['image', 'description'] },
  Recipe: { required: ['name', 'image'], recommended: ['author', 'recipeIngredient', 'recipeInstructions'] },
  Event: { required: ['name', 'startDate', 'location'], recommended: ['endDate', 'description', 'image'] },
  LocalBusiness: { required: ['name', 'address'], recommended: ['telephone', 'openingHours', 'image'] },
};

function present(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(present);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function typesOf(block) {
  const t = block?.['@type'];
  if (!t) return [];
  return Array.isArray(t) ? t : [t];
}

// FAQPage needs real questions: each with a name and an answer text.
function faqProblems(block) {
  const items = [].concat(block.mainEntity || []).filter(Boolean);
  if (!items.length) return [];
  const bad = items.filter((q) => {
    const answer = q?.acceptedAnswer;
    const answerText = Array.isArray(answer) ? answer[0]?.text : answer?.text;
    return !present(q?.name) || !present(answerText);
  });
  return bad.length ? [`${bad.length} of ${items.length} questions lack a name or an answer text`] : [];
}

export function ruleTypes() {
  return Object.keys(RULES);
}

// One finding per recognised type on the block: { type, missingRequired[], missingRecommended[] }.
export function validateBlock(block) {
  const findings = [];
  for (const type of typesOf(block)) {
    const rule = RULES[type];
    if (!rule) continue;
    const missingRequired = rule.required.filter((p) => !present(block[p]));
    for (const group of rule.anyOf || []) {
      if (!group.some((p) => present(block[p]))) missingRequired.push(`one of ${group.join('/')}`);
    }
    if (rule.custom === 'faq') missingRequired.push(...faqProblems(block));
    const missingRecommended = (rule.recommended || []).filter((p) => !present(block[p]));
    findings.push({ type, missingRequired, missingRecommended });
  }
  return findings;
}
