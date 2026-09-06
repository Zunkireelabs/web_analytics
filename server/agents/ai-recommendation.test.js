import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeProviderFacts, computeBlendedVisibilityPct, computeVoiceAndGap, verifyExtractedCompetitors } from './ai-recommendation.js';

// These exercise the pure, DB/API-free aggregation math only — the same
// functions run() itself calls. No real DB, no real provider calls: every
// input below is a hand-built stand-in for what a real probe run would
// have produced (mocked provider responses), per this codebase's existing
// convention of not standing up a live DB/LLM in unit tests (see
// generators/faq.test.js's input-validation-only style).

describe('computeProviderFacts', () => {
  test('one configured provider (today\'s default OpenAI-only shape)', () => {
    const perProviderResults = [
      { providerId: 'openai', checked: [
        { mentioned: true, model: 'gpt-4o-mini' },
        { mentioned: false, model: 'gpt-4o-mini' },
        { mentioned: true, model: 'gpt-4o-mini' },
      ] },
    ];
    assert.deepEqual(computeProviderFacts(perProviderResults), [
      { id: 'openai', model: 'gpt-4o-mini', promptsChecked: 3, mentionedCount: 2, aiVisibilityPct: 67 },
    ]);
  });

  test('a provider whose every probe failed this run gets aiVisibilityPct: null, never a fabricated 0%', () => {
    const perProviderResults = [
      { providerId: 'anthropic', checked: [] },
    ];
    assert.deepEqual(computeProviderFacts(perProviderResults), [
      { id: 'anthropic', model: null, promptsChecked: 0, mentionedCount: 0, aiVisibilityPct: null },
    ]);
  });

  test('multiple configured providers each get their own independent entry', () => {
    const perProviderResults = [
      { providerId: 'openai', checked: [{ mentioned: true, model: 'gpt-4o-mini' }, { mentioned: true, model: 'gpt-4o-mini' }] },
      { providerId: 'anthropic', checked: [{ mentioned: false, model: 'claude-haiku-4-5' }] },
    ];
    assert.deepEqual(computeProviderFacts(perProviderResults), [
      { id: 'openai', model: 'gpt-4o-mini', promptsChecked: 2, mentionedCount: 2, aiVisibilityPct: 100 },
      { id: 'anthropic', model: 'claude-haiku-4-5', promptsChecked: 1, mentionedCount: 0, aiVisibilityPct: 0 },
    ]);
  });
});

describe('computeBlendedVisibilityPct', () => {
  test('one provider — blended pct equals that provider\'s own rate exactly (backward compatibility with the pre-multi-provider pooled ratio)', () => {
    const providerFacts = [{ id: 'openai', model: 'gpt-4o-mini', promptsChecked: 4, mentionedCount: 3, aiVisibilityPct: 75 }];
    assert.equal(computeBlendedVisibilityPct(providerFacts), 75);
  });

  test('two providers with different rates — unweighted mean, not a pooled count', () => {
    // Pooled would be 6 mentioned / 11 checked = 55%; unweighted mean of
    // 80% and 33% is different (~57%) — asserting the mean, not the pool,
    // catches a regression back to the old pooled formula.
    const providerFacts = [
      { id: 'openai', model: 'gpt-4o-mini', promptsChecked: 10, mentionedCount: 8, aiVisibilityPct: 80 },
      { id: 'anthropic', model: 'claude-haiku-4-5', promptsChecked: 1, mentionedCount: 0, aiVisibilityPct: 0 },
    ];
    // mean(80, 0) = 40, NOT round(8/11*100) = 73
    assert.equal(computeBlendedVisibilityPct(providerFacts), 40);
  });

  test('a fully-failed provider (aiVisibilityPct: null) is excluded from the mean, not treated as 0', () => {
    const providerFacts = [
      { id: 'openai', model: 'gpt-4o-mini', promptsChecked: 5, mentionedCount: 4, aiVisibilityPct: 80 },
      { id: 'anthropic', model: null, promptsChecked: 0, mentionedCount: 0, aiVisibilityPct: null },
    ];
    assert.equal(computeBlendedVisibilityPct(providerFacts), 80); // not mean(80, 0) = 40
  });

  test('no providers at all returns 0 (defensive — run() already returns insufficient-data before reaching this)', () => {
    assert.equal(computeBlendedVisibilityPct([]), 0);
  });
});

describe('computeVoiceAndGap — Share of AI Voice / Competitor Citation Gap', () => {
  test('this company leads: negative gap, real share-of-voice percentage', () => {
    const result = computeVoiceAndGap({
      ourMentions: 8, totalProbes: 10,
      competitorCounts: new Map([['Acme', 3], ['Globex', 1]]),
    });
    // Share of voice: 8 / (8 + 3 + 1) = 8/12 = 67%
    assert.equal(result.shareOfAiVoicePct, 67);
    // Our rate 80%, Acme's rate 30% -> gap = 30 - 80 = -50 (we lead by 50)
    assert.equal(result.competitorCitationGapPct, -50);
    assert.equal(result.topCompetitorName, 'Acme');
  });

  test('a competitor leads: positive gap', () => {
    const result = computeVoiceAndGap({
      ourMentions: 2, totalProbes: 10,
      competitorCounts: new Map([['Acme', 7]]),
    });
    // Our rate 20%, Acme's rate 70% -> gap = 70 - 20 = +50 (Acme leads by 50)
    assert.equal(result.competitorCitationGapPct, 50);
    assert.equal(result.topCompetitorName, 'Acme');
  });

  test('no competitor ever mentioned — share of voice is 100%, gap is a full negative lead', () => {
    const result = computeVoiceAndGap({ ourMentions: 5, totalProbes: 10, competitorCounts: new Map() });
    assert.equal(result.shareOfAiVoicePct, 100);
    assert.equal(result.topCompetitorName, null);
    assert.equal(result.competitorCitationGapPct, -50); // 0 - 50
  });

  test('no real window data yet (totalProbes 0, no mentions at all) returns nulls, never NaN or a fabricated 0%', () => {
    const result = computeVoiceAndGap({ ourMentions: 0, totalProbes: 0, competitorCounts: new Map() });
    assert.equal(result.shareOfAiVoicePct, null);
    assert.equal(result.competitorCitationGapPct, null);
    assert.equal(result.ourWindowPct, null);
    assert.equal(result.topCompetitorWindowPct, null);
  });

  test('picks the single HIGHEST competitor, not the sum, as the "top" competitor for the gap', () => {
    const result = computeVoiceAndGap({
      ourMentions: 5, totalProbes: 10,
      competitorCounts: new Map([['Small', 1], ['Big', 6], ['Medium', 3]]),
    });
    assert.equal(result.topCompetitorName, 'Big');
    // Our rate 50%, Big's rate 60% -> gap = 60 - 50 = +10
    assert.equal(result.competitorCitationGapPct, 10);
  });
});

describe('verifyExtractedCompetitors', () => {
  // detectMention has always regex-verified THIS company against the raw
  // answer text. The extraction pass's competitor names had no such check, so
  // a name the model pattern-completed rather than read could be persisted
  // and then counted into shareOfAiVoicePct / the rising-competitor findings
  // as if it were a real occurrence.
  const raw = 'For roofing in Denver, look at Summit Roofing or Rival Roofing Co. Both are well reviewed.';

  test('keeps names that really occur in the raw answer', () => {
    assert.deepEqual(
      verifyExtractedCompetitors(raw, ['Summit Roofing', 'Rival Roofing Co']),
      ['Summit Roofing', 'Rival Roofing Co']
    );
  });

  test('drops a name the model produced that is not in the answer at all', () => {
    assert.deepEqual(verifyExtractedCompetitors(raw, ['Summit Roofing', 'Apex Roofing']), ['Summit Roofing']);
  });

  test('matching is case-insensitive but whole-match, never a substring accident', () => {
    assert.deepEqual(verifyExtractedCompetitors(raw, ['summit roofing']), ['summit roofing']);
    // "Rival" is a whole word here; "Riva" is only ever part of one.
    assert.deepEqual(verifyExtractedCompetitors(raw, ['Riva']), []);
  });

  test('de-duplicates names differing only by case', () => {
    assert.deepEqual(verifyExtractedCompetitors(raw, ['Summit Roofing', 'summit roofing']), ['Summit Roofing']);
  });

  test('a missing/!array/garbage extraction result is an empty list, never a throw', () => {
    assert.deepEqual(verifyExtractedCompetitors(raw, undefined), []);
    assert.deepEqual(verifyExtractedCompetitors(raw, null), []);
    assert.deepEqual(verifyExtractedCompetitors(raw, 'Summit Roofing'), []);
    assert.deepEqual(verifyExtractedCompetitors(raw, [null, 42, '', 'x']), []);
  });
});
