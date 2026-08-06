import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, isRetryable } from './llm.js';

// Regression coverage for a real, recurring report: multiple generators
// (schema, faq, expand-content, meta-title, ...) failed with "model did not
// return valid JSON" whenever the LLM wrapped its response in prose or a
// code fence despite an explicit "respond with ONLY JSON" instruction.
// extractJson is the shared, lenient parser callLLMForJson uses before
// giving up and retrying.
describe('extractJson', () => {
  test('parses a clean JSON object', () => {
    assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
  });

  test('parses a clean JSON array', () => {
    assert.deepEqual(extractJson('[1, 2, 3]'), [1, 2, 3]);
  });

  test('strips a markdown code fence', () => {
    assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('```\n{"a": 1}\n```'), { a: 1 });
  });

  test('extracts JSON from surrounding prose the model added despite instructions', () => {
    const raw = 'Sure, here is the JSON you requested:\n{"a": 1, "b": [1, 2]}\nLet me know if you need anything else!';
    assert.deepEqual(extractJson(raw), { a: 1, b: [1, 2] });
  });

  test('returns null (never throws) for genuinely unparseable text', () => {
    assert.equal(extractJson('this is not json at all'), null);
    assert.equal(extractJson(''), null);
    assert.equal(extractJson(null), null);
  });

  test('returns null for truncated/incomplete JSON rather than throwing', () => {
    assert.equal(extractJson('{"a": 1, "b": [1, 2'), null);
  });
});

describe('isRetryable', () => {
  test('true for 429 and 5xx status', () => {
    assert.equal(isRetryable({ status: 429 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
  });

  test('true for known transient network error codes', () => {
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
  });

  test('false for a normal client error', () => {
    assert.equal(isRetryable({ status: 400 }), false);
  });
});
