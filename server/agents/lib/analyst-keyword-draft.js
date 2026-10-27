// "Write for it" on a keyword the Analyst predicts can grow: the same blog-outline draft the AI
// visibility page and the daily run produce, landing in Action Center under its normal approval
// rules. Only a keyword the Analyst itself currently predicts is accepted, so the button cannot be
// used to ask for arbitrary text to be generated. Deps are injected so this stays unit-testable.
export async function draftForPredictedKeyword(siteId, keyword, { predicted = [], findDraftByTopic, generate }) {
  const text = String(keyword || '').replace(/\s+/g, ' ').trim();
  const match = predicted.find((k) => String(k.keyword).toLowerCase() === text.toLowerCase());
  if (!match) {
    const err = new Error('That keyword is not one the Analyst currently predicts can grow.');
    err.status = 404;
    throw err;
  }
  const existing = await findDraftByTopic(siteId, match.keyword);
  if (existing) return { draftId: existing, reused: true };
  const draft = await generate(siteId, {
    generatorId: 'blog-outline',
    params: {
      topic: match.keyword,
      context: `A keyword the Analyst predicts can reach page 1 (now position ${match.position}, about ${match.gainClicks} extra clicks a month if it does).`,
    },
    source: 'analyst-outlook',
    findingOrigin: 'analyst',
    findingId: `analyst-outlook:keyword:${match.keyword.toLowerCase()}`,
  });
  return { draftId: draft.id, reused: false };
}
