import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatTenantContextForPrompt, TENANT_CONTEXT_SECTIONS } from './tenant-context.js';

// The formatter is pure, so the prompt contract is tested directly; loading
// is a composition of existing store readers that each have their own tests.

const ctx = (over = {}) => ({
  site: { id: 1 }, siteId: 1, propertyType: 'product', isProduct: true,
  goals: [], productFactsText: '', industries: null, markets: null, icpSignals: null,
  ...over,
});

describe('formatTenantContextForPrompt', () => {
  test('an empty context produces NOTHING, not an empty heading', () => {
    // A heading with nothing under it invites the model to fill the gap,
    // which is the exact fabrication this is meant to prevent.
    assert.equal(formatTenantContextForPrompt(ctx()), '');
    assert.equal(formatTenantContextForPrompt(null), '');
  });

  test('industry is stated when known', () => {
    const out = formatTenantContextForPrompt(ctx({ industries: ['education', 'technology'] }));
    assert.match(out, /industry: education, technology/);
  });

  test('goals use the required objective sentence, not the bare goal type', () => {
    // createGoal rejects a goal with no objective precisely because the type
    // alone is "not specific enough to match findings against".
    const out = formatTenantContextForPrompt(ctx({
      goals: [{ goalType: 'book_demos', objective: 'Book 20 demos a month', primaryMetric: 'demo_requests' }],
    }));
    assert.match(out, /Book 20 demos a month/);
    assert.match(out, /measured by demo_requests/);
    assert.doesNotMatch(out, /book_demos/);
  });

  test('goals are capped so a long list cannot crowd out the rest of the prompt', () => {
    const goals = Array.from({ length: 10 }, (_, i) => ({ objective: `Goal ${i}` }));
    const out = formatTenantContextForPrompt(ctx({ goals }), { maxGoals: 3 });

    assert.match(out, /Goal 0/);
    assert.doesNotMatch(out, /Goal 3/);
  });

  test('product facts are stated as facts to use, with an explicit do-not-invent instruction', () => {
    // productFactsText is rendered during loading by the landing-page
    // generator's own formatProductFacts, so this stays pure and the two
    // generators can never state the same rows differently.
    const out = formatTenantContextForPrompt(ctx({
      productFactsText: '- Keyword tracking: Tracks daily rank',
    }));
    assert.match(out, /never invent others/);
    assert.match(out, /Keyword tracking/);
  });

  test('markets and ICP signals render as the audience section', () => {
    const out = formatTenantContextForPrompt(ctx({ markets: ['Nepal', 'India'], icpSignals: ['SaaS', '10-50 staff'] }));
    assert.match(out, /Target markets: Nepal, India/);
    assert.match(out, /Ideal customer signals: SaaS, 10-50 staff/);
  });

  test('a caller can take only the sections it needs', () => {
    const full = ctx({ industries: ['education'], goals: [{ objective: 'Grow signups' }] });
    const out = formatTenantContextForPrompt(full, { sections: ['business'] });

    assert.match(out, /education/);
    assert.doesNotMatch(out, /Grow signups/);
  });

  test('a single non-array ICP signal does not crash the formatter', () => {
    const out = formatTenantContextForPrompt(ctx({ icpSignals: 'SaaS founders' }));
    assert.match(out, /SaaS founders/);
  });

  test('the default section list is the full set', () => {
    assert.deepEqual([...TENANT_CONTEXT_SECTIONS], ['business', 'goals', 'product', 'audience']);
  });
});
