import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, isRetryable, callLLMForJson } from './llm.js';

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

// Regression coverage: expand-content.js used to parse fine but reject a
// well-formed-JSON-but-wrong-shape response (an object where an array was
// required) with a single unconditional throw — skipping the same
// corrective-nudge retry a genuinely unparseable response already got.
// `validate` extends that retry to shape failures too.
describe('callLLMForJson — validate option', () => {
  test('retries once with a corrective nudge when parsed JSON fails validate(), then accepts a valid retry', async () => {
    const original = globalThis.fetch;
    const originalProvider = process.env.REPORT_PROVIDER;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const text = calls === 1 ? '{"not": "an array"}' : '[{"heading": "h", "body": "b"}]';
      const body = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await callLLMForJson('system', 'user', { validate: Array.isArray });
      assert.equal(calls, 2);
      assert.deepEqual(result, [{ heading: 'h', body: 'b' }]);
    } finally {
      globalThis.fetch = original;
      if (originalProvider === undefined) delete process.env.REPORT_PROVIDER;
      else process.env.REPORT_PROVIDER = originalProvider;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  test('throws after 2 attempts if validate() never passes', async () => {
    const original = globalThis.fetch;
    const originalProvider = process.env.REPORT_PROVIDER;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = async () => {
      const body = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '{"not": "an array"}' }], model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      await assert.rejects(() => callLLMForJson('system', 'user', { validate: Array.isArray }), /did not return valid JSON/);
    } finally {
      globalThis.fetch = original;
      if (originalProvider === undefined) delete process.env.REPORT_PROVIDER;
      else process.env.REPORT_PROVIDER = originalProvider;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
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
