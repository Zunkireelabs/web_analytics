import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, toAnthropicMessages } from './llm-stream.js';
import { _resetQuotaBreakerForTest } from './llm.js';

afterEach(() => _resetQuotaBreakerForTest());

const OPENAI_ENV = { OPENAI_API_KEY: 'sk-real', ANTHROPIC_API_KEY: 'ak-real' };
const ANTHROPIC_ENV = { ANTHROPIC_API_KEY: 'ak-real' };

async function* chunks(list) { for (const c of list) yield c; }
const textChunk = (t) => ({ choices: [{ delta: { content: t } }] });

function fakeOpenAi(streamFn) {
  const calls = [];
  return { calls, client: { chat: { completions: { create: async (body, opts) => { calls.push({ body, opts }); return streamFn(body); } } } } };
}
function fakeAnthropic({ events = [], final }) {
  const calls = [];
  return {
    calls,
    client: { messages: { stream: (body, opts) => {
      calls.push({ body, opts });
      const handlers = {};
      return { on: (e, fn) => { handlers[e] = fn; }, finalMessage: async () => { for (const t of events) handlers.text?.(t); return final; } };
    } } },
  };
}

describe('streamChat — OpenAI', () => {
  test('forwards text as it arrives and returns the whole text', async () => {
    const { client, calls } = fakeOpenAi(() => chunks([textChunk('Hel'), textChunk('lo '), textChunk('there'), { usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [] }]));
    const seen = [];
    const r = await streamChat({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], onText: (t) => seen.push(t) }, { clients: { openai: client }, env: OPENAI_ENV });
    assert.deepEqual(seen, ['Hel', 'lo ', 'there']);
    assert.equal(r.text, 'Hello there');
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.provider, 'openai');
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.messages[0].role, 'system');
    assert.equal(calls[0].body.tools, undefined, 'no tools key when none are offered');
  });

  test('assembles a tool call from fragments, in order', async () => {
    const frag = (index, extra) => ({ choices: [{ delta: { tool_calls: [{ index, ...extra }] } }] });
    const { client } = fakeOpenAi(() => chunks([
      frag(0, { id: 'c1', function: { name: 'get_pr_activity', arguments: '{"per' } }),
      frag(0, { function: { arguments: 'iod":"today"}' } }),
      frag(1, { id: 'c2', function: { name: 'get_needs_you', arguments: '' } }),
    ]));
    const r = await streamChat({ system: 's', messages: [], tools: [{ type: 'function', function: { name: 'x' } }] }, { clients: { openai: client }, env: OPENAI_ENV });
    assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'get_pr_activity', args: { period: 'today' } }, { id: 'c2', name: 'get_needs_you', args: {} }]);
  });

  test('quota exhausted before any text: answered by Claude instead, still streaming', async () => {
    const quota = Object.assign(new Error('You exceeded your current quota'), { status: 429, code: 'insufficient_quota' });
    const openai = fakeOpenAi(() => { throw quota; });
    const claude = fakeAnthropic({ events: ['From ', 'Claude'], final: { content: [{ type: 'text', text: 'From Claude' }], usage: { input_tokens: 5, output_tokens: 2 } } });
    const seen = [];
    const r = await streamChat({ system: 's', messages: [{ role: 'user', content: 'q' }], onText: (t) => seen.push(t) }, { clients: { openai: openai.client, anthropic: claude.client }, env: OPENAI_ENV });
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.text, 'From Claude');
    assert.deepEqual(seen, ['From ', 'Claude']);
  });

  test('a failure AFTER words were shown is thrown, never silently re-answered', async () => {
    const quota = Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' });
    async function* partial() { yield textChunk('Half an ans'); throw quota; }
    const openai = fakeOpenAi(() => partial());
    const claude = fakeAnthropic({ final: { content: [] } });
    await assert.rejects(
      streamChat({ system: 's', messages: [], onText: () => {} }, { clients: { openai: openai.client, anthropic: claude.client }, env: OPENAI_ENV }),
      /quota/,
    );
    assert.equal(claude.calls.length, 0);
  });

  test('a non-quota error is thrown as is', async () => {
    const openai = fakeOpenAi(() => { throw Object.assign(new Error('bad request'), { status: 400 }); });
    await assert.rejects(streamChat({ system: 's', messages: [] }, { clients: { openai: openai.client }, env: OPENAI_ENV }), /bad request/);
  });
});

describe('streamChat — Anthropic', () => {
  test('streams text and returns tool_use blocks as tool calls', async () => {
    const { client, calls } = fakeAnthropic({
      events: ['One ', 'moment'],
      final: { content: [{ type: 'text', text: 'One moment' }, { type: 'tool_use', id: 'tu1', name: 'get_findings', input: { limit: 3 } }], usage: { input_tokens: 9, output_tokens: 4 } },
    });
    const seen = [];
    const r = await streamChat(
      { system: 'sys', messages: [{ role: 'user', content: 'q' }], tools: [{ type: 'function', function: { name: 'get_findings', description: 'd', parameters: { type: 'object', properties: {} } } }], onText: (t) => seen.push(t) },
      { clients: { anthropic: client }, env: ANTHROPIC_ENV },
    );
    assert.deepEqual(seen, ['One ', 'moment']);
    assert.deepEqual(r.toolCalls, [{ id: 'tu1', name: 'get_findings', args: { limit: 3 } }]);
    assert.equal(calls[0].body.system, 'sys');
    assert.equal(calls[0].body.tools[0].name, 'get_findings');
    assert.equal(calls[0].body.messages[0].role, 'user');
  });
});

describe('toAnthropicMessages', () => {
  test('tool results go first in a user turn; assistant tool_calls become tool_use', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'a', type: 'function', function: { name: 'get_needs_you', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: '{"total":0}' },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[1].content.map((b) => b.type), ['text', 'tool_use']);
    assert.equal(out[2].role, 'user');
    assert.equal(out[2].content[0].type, 'tool_result');
    assert.equal(out[2].content[0].tool_use_id, 'a');
  });
});
