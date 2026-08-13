import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { problemSignatureFor, buildRepairRecipe, requiredEvidenceFor, isRepairEligible } from './learned-repair.js';
import { riskTierForGenerator } from './risk-tiers.js';

describe('problemSignatureFor — the shared retrieval key', () => {
  test('sorts tags, so the same problem keys identically whatever order they arrive in', () => {
    // This is the whole point. recommendationsFor/contentGapsFor return
    // arrays with no guaranteed order; unsorted, the same problem on two
    // sites produces two different keys, every cross-client lookup misses,
    // and the feature silently does nothing with no error anywhere.
    assert.equal(
      problemSignatureFor('alt-text', ['missing-alt', 'decorative-svg']),
      problemSignatureFor('alt-text', ['decorative-svg', 'missing-alt']),
    );
  });

  test('is stable and readable', () => {
    assert.equal(problemSignatureFor('alt-text', ['b', 'a']), 'alt-text:a,b');
  });

  test('falls back when there are no tags, matching the original behavior', () => {
    assert.equal(problemSignatureFor('faq', [], 'content-gap'), 'faq:content-gap');
    assert.equal(problemSignatureFor('faq', null, 'opportunity'), 'faq:opportunity');
  });

  test('ignores empty/null tags rather than emitting empty segments', () => {
    assert.equal(problemSignatureFor('schema', ['a', null, '', 'b']), 'schema:a,b');
  });
});

describe('buildRepairRecipe', () => {
  test('produces a chain descriptor, never a literal edit', () => {
    const recipe = buildRepairRecipe('alt-text');
    assert.deepEqual(recipe, { kind: 'generator-chain', generatorId: 'alt-text', version: 1 });
    // An anchor is one site's own source bytes and is meaningless elsewhere —
    // if this ever starts carrying replacement text, the portability model
    // has been broken.
    assert.ok(!('anchor' in recipe));
    assert.ok(!('replacement' in recipe));
  });

  test('returns null for a generator that may never repair cross-client', () => {
    assert.equal(buildRepairRecipe('landing-page'), null);
    assert.equal(buildRepairRecipe('blog-outline'), null);
    assert.equal(buildRepairRecipe('geo-audit'), null);
    assert.equal(buildRepairRecipe(null), null);
  });
});

describe('evidence tiers', () => {
  test('exact-match-or-refuse generators need the least corroboration', () => {
    // Their implementer re-derives anchors from the target repo and refuses
    // all-or-nothing, so a wrong match declines rather than half-writing.
    assert.equal(requiredEvidenceFor('alt-text'), 2);
    assert.equal(requiredEvidenceFor('schema-repair'), 2);
  });

  test('deterministic no-LLM generators need more', () => {
    assert.equal(requiredEvidenceFor('canonical'), 3);
    assert.equal(requiredEvidenceFor('security-headers'), 3);
  });

  test('LLM prose generators need the most — they write customer-facing copy', () => {
    assert.equal(requiredEvidenceFor('meta-title'), 4);
    assert.equal(requiredEvidenceFor('faq'), 4);
    assert.equal(requiredEvidenceFor('expand-content'), 4);
  });

  test('every safe-tier generator is eligible — the agreed scope is all 17', () => {
    const safe = ['meta-title', 'faq', 'schema', 'llms-txt', 'internal-links', 'sitemap', 'robots-fix',
      'security-headers', 'html-lang', 'canonical', 'viewport', 'open-graph', 'expand-content',
      'qa-content', 'breadcrumbs', 'schema-repair', 'alt-text'];
    for (const id of safe) {
      assert.equal(riskTierForGenerator(id), 'safe', `${id} is expected to be safe-tier`);
      assert.ok(isRepairEligible(id), `${id} should be repair-eligible`);
    }
    assert.equal(safe.length, 17);
  });

  test('a manual-tier generator is refused even if the tier table lists it', () => {
    // Defence in depth: risk-tiers.js stays the source of truth for "may this
    // ever run unattended", so a generator demoted there is refused here
    // without anyone having to remember to edit two lists.
    assert.equal(riskTierForGenerator('broken-link-fix'), 'manual');
    assert.equal(requiredEvidenceFor('broken-link-fix'), null);
    assert.equal(isRepairEligible('broken-link-fix'), false);
  });

  test('an unknown generator is refused, not defaulted', () => {
    assert.equal(requiredEvidenceFor('some-future-generator'), null);
    assert.equal(isRepairEligible(undefined), false);
  });
});
