import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFaqQuestion, faqQuestionsNotVisible, checkSchemaOnlyFaqMatchesVisible,
} from './faq-render-mode.js';

// No database and no network: the live page is injected.
const draft = (...qs) => qs.map((question) => ({ question, answer: `Answer to ${question}` }));
const live = (visible = [], bodyText = '') => async () => ({
  ok: true,
  analysis: { faqVisibleItems: visible.map((question) => ({ question, answer: 'a' })), bodyText },
});

describe('normalizeFaqQuestion', () => {
  test('ignores case, spacing, a trailing question mark, entities and curly quotes', () => {
    assert.equal(normalizeFaqQuestion('  What  is Orca?  '), 'what is orca');
    assert.equal(normalizeFaqQuestion('What is R&amp;D?'), 'what is r&d');
    assert.equal(normalizeFaqQuestion('How do I get started with Zunkiree’s tool?'), "how do i get started with zunkiree's tool");
  });
  test('treats null and undefined as empty', () => {
    assert.equal(normalizeFaqQuestion(null), '');
    assert.equal(normalizeFaqQuestion(undefined), '');
  });
});

describe('faqQuestionsNotVisible', () => {
  test('returns only the draft questions the page does not show', () => {
    const missing = faqQuestionsNotVisible(draft('What is GaaS?', 'What does it cost?'), [{ question: 'What is GaaS?' }], '');
    assert.deepEqual(missing, ['What does it cost?']);
  });
  test('a question shown in plain page text counts as visible even if the FAQ extractor missed it', () => {
    assert.deepEqual(faqQuestionsNotVisible(draft('What does it cost?'), [], 'Intro. What does it cost? About a lot. Outro.'), []);
  });
  test('wording differences are real differences', () => {
    // "How do I get started?" vs "How do I get started with Zunkiree Labs?" is
    // the pricing-page mismatch this check exists to catch.
    const missing = faqQuestionsNotVisible(draft('How do I get started with Zunkiree Labs?'), [{ question: 'How do I get started?' }], 'How do I get started?');
    assert.deepEqual(missing, ['How do I get started with Zunkiree Labs?']);
  });
});

describe('checkSchemaOnlyFaqMatchesVisible', () => {
  test('ok when every draft question is already visible (schema for an FAQ the page shows)', async () => {
    const r = await checkSchemaOnlyFaqMatchesVisible('/p/', draft('A?', 'B?'), { readLivePage: live(['A?', 'B?', 'C?']) });
    assert.deepEqual(r, { ok: true });
  });

  test('the 11-versus-6 case: a visible FAQ of 6 plus a draft of 11 publishes nothing', async () => {
    const visible = ['q1?', 'q2?', 'q3?', 'q4?', 'q5?', 'q6?'];
    const all = [...visible, 'q7?', 'q8?', 'q9?', 'q10?', 'q11?'];
    const r = await checkSchemaOnlyFaqMatchesVisible('/state-of-ai-nepal-2026/', draft(...all), { readLivePage: live(visible) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'faq-schema-not-visible');
    assert.deepEqual(r.missing, ['q7?', 'q8?', 'q9?', 'q10?', 'q11?']);
    assert.match(r.error, /5 of 11 question\(s\)/);
    assert.match(r.error, /not published/i);
  });

  test('refuses when the page shows no FAQ at all (for example the visible-FAQ cap was reached)', async () => {
    const r = await checkSchemaOnlyFaqMatchesVisible('/p/', draft('What does it cost?'), { readLivePage: live([], 'A page with no FAQ.') });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'faq-schema-not-visible');
  });

  test('a short question is not "found" inside an unrelated word', async () => {
    // Whole-phrase matching: "cost" must not match inside "costly".
    const r = await checkSchemaOnlyFaqMatchesVisible('/p/', draft('Cost?'), { readLivePage: live([], 'It is a costly page about pricing.') });
    assert.equal(r.ok, false);
  });

  test('refuses, as unverifiable, when the live page cannot be read', async () => {
    const r = await checkSchemaOnlyFaqMatchesVisible('/p/', draft('A?'), { readLivePage: async () => ({ ok: false, error: 'timeout' }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'faq-schema-unverifiable');
  });

  test('a thrown live fetch is caught and treated as unverifiable', async () => {
    const r = await checkSchemaOnlyFaqMatchesVisible('/p/', draft('A?'), { readLivePage: async () => { throw new Error('boom'); } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'faq-schema-unverifiable');
  });

  test('a draft with no items has nothing to publish and is not judged here', async () => {
    assert.deepEqual(await checkSchemaOnlyFaqMatchesVisible('/p/', [], { readLivePage: live() }), { ok: true });
    assert.deepEqual(await checkSchemaOnlyFaqMatchesVisible('/p/', undefined, { readLivePage: live() }), { ok: true });
  });
});
