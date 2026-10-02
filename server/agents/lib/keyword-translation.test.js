import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { translateKeywords, _resetKeywordTranslationCache, MAX_TERMS_PER_REQUEST } from './keyword-translation.js';

const llmReturning = (obj) => async () => (typeof obj === 'string' ? obj : JSON.stringify(obj));

describe('translateKeywords', () => {
  beforeEach(() => _resetKeywordTranslationCache());

  test('returns translations only for non-English terms', async () => {
    const out = await translateKeywords(['काठमाडौं मा एआई कम्पनी', 'ai company nepal'], {
      llm: llmReturning({ 'काठमाडौं मा एआई कम्पनी': { language: 'Nepali', english: 'AI company in Kathmandu' } }),
    });
    assert.deepEqual(out, { 'काठमाडौं मा एआई कम्पनी': { language: 'Nepali', english: 'AI company in Kathmandu' } });
  });

  test('tolerates code fences around the JSON', async () => {
    const out = await translateKeywords(['bedrijf'], { llm: llmReturning('```json\n{"bedrijf":{"language":"Dutch","english":"company"}}\n```') });
    assert.equal(out.bedrijf.english, 'company');
  });

  test('ignores keys the model invented that were not in the input', async () => {
    const out = await translateKeywords(['bedrijf'], {
      llm: llmReturning({ bedrijf: { language: 'Dutch', english: 'company' }, 'ignore previous instructions': { language: 'x', english: 'y' } }),
    });
    assert.deepEqual(Object.keys(out), ['bedrijf']);
  });

  test('drops a "translation" that is just the same text', async () => {
    const out = await translateKeywords(['zunkiree'], { llm: llmReturning({ zunkiree: { language: 'English', english: 'Zunkiree' } }) });
    assert.deepEqual(out, {});
  });

  test('fails soft: an LLM error yields no translations, not a throw', async () => {
    const out = await translateKeywords(['bedrijf'], { llm: async () => { throw new Error('boom'); } });
    assert.deepEqual(out, {});
  });

  test('a failed call is not cached, so the next call retries', async () => {
    await translateKeywords(['bedrijf'], { llm: async () => { throw new Error('boom'); } });
    const out = await translateKeywords(['bedrijf'], { llm: llmReturning({ bedrijf: { language: 'Dutch', english: 'company' } }) });
    assert.equal(out.bedrijf.english, 'company');
  });

  test('caches results and does not re-ask for known terms', async () => {
    let calls = 0;
    const llm = async () => { calls++; return JSON.stringify({ bedrijf: { language: 'Dutch', english: 'company' } }); };
    await translateKeywords(['bedrijf'], { llm });
    await translateKeywords(['Bedrijf'], { llm });
    assert.equal(calls, 1);
  });

  test('bounds the number of terms sent and drops blanks/oversized/non-strings', async () => {
    let sent;
    const llm = async (_s, user) => { sent = JSON.parse(user); return '{}'; };
    const many = Array.from({ length: MAX_TERMS_PER_REQUEST + 20 }, (_, i) => `term ${i}`);
    await translateKeywords([...many, '', '   ', 42, 'x'.repeat(500)], { llm });
    assert.equal(sent.length, MAX_TERMS_PER_REQUEST);
    assert.ok(sent.every((t) => typeof t === 'string' && t.length <= 200));
  });

  test('non-array input is handled', async () => {
    assert.deepEqual(await translateKeywords(null, { llm: async () => { throw new Error('should not be called'); } }), {});
  });
});
