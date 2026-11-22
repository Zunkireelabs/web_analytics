import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureClassification, needsTypeReview } from './content-type.js';
import { runQualityGate } from './quality-gate.js';
import { _resetArticlePageCacheForTest } from './article-page.js';

// The whole life of a draft, with the REAL shared pieces: generateDraft's classification step -> what the draft stores (a JSON round trip
// stands in for the drafts.input column) -> the Quality Gate at generation, at repair and at approval, reading ONLY what was stored.
// (generateDraft itself is not run here: it needs the design agent, GitHub and the database. The step it performs is ensureClassification,
// called exactly as it calls it, and the gate calls below are made with the same arguments action-center.js passes.)
const site = {
  url_file_map: {
    siteRoot: { visibleClaimBans: ['consultancy'], visibleClaimBansExemptArticlePages: true },
    newContentTargets: { 'blog-outline': { urlPattern: '/blogs/{slug}' }, 'landing-page': { urlPattern: '/{slug}' } },
  },
};
const copy = { sections: [{ heading: 'Choosing a partner', body: 'A reliable study abroad consultancy helps you compare options and plan every step of your application with clear, honest guidance.' }] };
const banned = (r) => r.issues.some((i) => i.patternId === 'banned-visible-claim');
const throughStorage = (v) => JSON.parse(JSON.stringify(v));

// The three gate calls a draft meets after it is created, each reading only the stored draft, as action-center.js does.
async function laterGates(draft, generatorId) {
  const args = { site, page: draft.content?.page || draft.input?.page || null, pageType: draft.input?.pageType || null, pageClassification: draft.input?.pageClassification || null };
  return {
    repair: await runQualityGate(draft.content, generatorId, 1, args),
    approval: await runQualityGate(draft.content, generatorId, 1, args),
  };
}

beforeEach(() => _resetArticlePageCacheForTest());

describe('draft lifecycle: creation -> gate -> repair -> approval', () => {
  test('a blog draft with NO URL is classified once, stored, and then passes every later gate for the copy a landing page would fail', async () => {
    const { params, classification } = await ensureClassification({ site, generatorId: 'blog-outline', params: { topic: 'UK visa rules' } });
    const draft = { input: throughStorage(params), content: copy };
    assert.equal(draft.input.pageType, 'blog');
    assert.ok(draft.input.pageClassification.evidence.length >= 1, 'the evidence is stored with the draft');
    assert.equal(draft.input.pageClassification.resolvedAt, classification.resolvedAt);
    assert.equal(banned(await runQualityGate(draft.content, 'blog-outline', 1, { site, page: null, pageType: draft.input.pageType, pageClassification: draft.input.pageClassification })), false, 'at generation');
    const later = await laterGates(draft, 'blog-outline');
    assert.equal(banned(later.repair), false, 'at repair');
    assert.equal(banned(later.approval), false, 'at approval');
  });

  test('a landing-page draft with NO URL is held to the full ban at every stage — a missing URL does not make it a blog', async () => {
    const { params } = await ensureClassification({ site, generatorId: 'landing-page', params: { topic: 'Study in Canada' } });
    const draft = { input: throughStorage(params), content: copy };
    assert.equal(draft.input.pageType, 'landing-page');
    const later = await laterGates(draft, 'landing-page');
    assert.equal(banned(later.repair), true);
    assert.equal(banned(later.approval), true);
  });

  test('an existing blog post edited by a DIFFERENT generator (faq) is recognised from its URL and exempt at every stage', async () => {
    const { params } = await ensureClassification({ site, generatorId: 'faq', params: { page: 'https://x.test/blogs/existing-post', query: 'q' } });
    const draft = { input: throughStorage(params), content: { ...copy, page: 'https://x.test/blogs/existing-post' } };
    const later = await laterGates(draft, 'faq');
    assert.equal(banned(later.repair), false); assert.equal(banned(later.approval), false);
  });

  test('the stored result is what later stages read: it is not re-derived, even if the page param is later changed', async () => {
    const { params } = await ensureClassification({ site, generatorId: 'blog-outline', params: {} });
    const draft = { input: { ...throughStorage(params), page: 'https://x.test/some-landing-page' }, content: copy };
    const later = await laterGates(draft, 'blog-outline');
    assert.equal(banned(later.approval), false, 'the stored blog classification stands');
  });

  test('a draft made BEFORE this existed (nothing stored) is resolved on the spot by the same function, with the same answer', async () => {
    const legacy = { input: { topic: 'old' }, content: copy };
    const gate = await runQualityGate(legacy.content, 'blog-outline', 1, { site, page: null, pageType: null, pageClassification: null });
    assert.equal(banned(gate), false, 'blog-outline is a blog post by its generator, with or without a stored result');
    const gate2 = await runQualityGate(legacy.content, 'landing-page', 1, { site, page: null, pageType: null, pageClassification: null });
    assert.equal(banned(gate2), true);
  });

  test('an unidentified type applies the STRICT rules at every stage and is flagged for review (nothing is weakened)', async () => {
    const { params, classification } = await ensureClassification({ site, generatorId: 'faq', params: {} });
    const draft = { input: throughStorage(params), content: copy };
    assert.equal(classification.status, 'unknown');
    assert.equal('pageType' in draft.input, false);
    const later = await laterGates(draft, 'faq');
    assert.equal(banned(later.repair), true); assert.equal(banned(later.approval), true);
    assert.equal(needsTypeReview(draft.input.pageClassification, site), true);
  });

  test('conflicting evidence is strict and flagged, not resolved by picking a side', async () => {
    const { params } = await ensureClassification({ site, generatorId: 'landing-page', params: { page: 'https://x.test/blogs/oops' } });
    const draft = { input: throughStorage(params), content: copy };
    assert.equal(draft.input.pageClassification.status, 'conflict');
    assert.equal(banned((await laterGates(draft, 'landing-page')).approval), true);
    assert.equal(needsTypeReview(draft.input.pageClassification, site), true);
  });
});
