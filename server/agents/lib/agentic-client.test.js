import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicTools, toAnthropicRequest, fromAnthropicResponse, makeAgenticClient } from './agentic-client.js';
import { _resetQuotaBreakerForTest, llmFallbackState } from '../../llm.js';

const tools = [
  { type: 'function', function: { name: 'content-gap', description: 'gaps', parameters: { type: 'object', properties: { page: { type: 'string' } } } } },
  { type: 'function', function: { name: 'ask_user', description: 'ask', parameters: { type: 'object', properties: { question: { type: 'string' } } } } },
];
const quota429 = Object.assign(new Error('429 Your project has reached its configured enforced spend limit.'), { status: 429, code: 'project_spend_limit_exceeded' });
const env = { OPENAI_API_KEY: 'sk-real', ANTHROPIC_API_KEY: 'sk-ant-real' };

describe('conversion to Claude', () => {
  test('tool definitions become input_schema tools', () => {
    const t = toAnthropicTools(tools);
    assert.equal(t[0].name, 'content-gap');
    assert.deepEqual(t[0].input_schema.properties, { page: { type: 'string' } });
    assert.equal(t[0].function, undefined);
  });

  test('system messages join into system; tool calls become tool_use; results become one user turn with tool_result first', () => {
    const { system, messages } = toAnthropicRequest([
      { role: 'system', content: 'be an analyst' },
      { role: 'user', content: 'why did traffic drop?' },
      { role: 'system', content: '[internal plan] check content-gap' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'content-gap', arguments: '{"page":"/a"}' } },
        { id: 'c2', type: 'function', function: { name: 'device-intelligence', arguments: '' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: '{"status":"ok"}' },
      { role: 'tool', tool_call_id: 'c2', content: '{"status":"ok"}' },
      { role: 'user', content: 'Give your final answer now.' },
    ]);
    assert.equal(system, 'be an analyst\n\n[internal plan] check content-gap');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(messages[1].content.map((b) => b.type), ['tool_use', 'tool_use']);
    assert.deepEqual(messages[1].content[0].input, { page: '/a' });
    assert.deepEqual(messages[1].content[1].input, {}); // empty arguments never crash
    assert.deepEqual(messages[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
    assert.equal(messages[2].content[0].tool_use_id, 'c1');
  });

  test('a malformed arguments string becomes empty input instead of throwing', () => {
    const { messages } = toAnthropicRequest([{ role: 'user', content: 'q' }, { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'a', arguments: '{bad' } }] }]);
    assert.deepEqual(messages[1].content[0].input, {});
  });

  test('a Claude response becomes the OpenAI shape the loop reads', () => {
    const r = fromAnthropicResponse({ content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'tu1', name: 'content-gap', input: { page: '/a' } }], usage: { input_tokens: 10, output_tokens: 4 } });
    const m = r.choices[0].message;
    assert.equal(m.content, 'checking');
    assert.equal(m.tool_calls[0].id, 'tu1');
    assert.equal(m.tool_calls[0].function.name, 'content-gap');
    assert.equal(m.tool_calls[0].function.arguments, '{"page":"/a"}');
    assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 4 });
    assert.equal(fromAnthropicResponse({ content: [{ type: 'text', text: 'done' }] }).choices[0].message.tool_calls, undefined);
  });
});

describe('provider routing', () => {
  beforeEach(() => _resetQuotaBreakerForTest());
  const okOpenAi = () => { const calls = []; return { calls, chat: { completions: { create: async (p) => { calls.push(p); return { choices: [{ message: { role: 'assistant', content: 'from openai' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } } } }; };
  const quotaOpenAi = () => { const calls = []; return { calls, chat: { completions: { create: async (p) => { calls.push(p); throw quota429; } } } }; };
  const claude = () => { const calls = []; return { calls, messages: { create: async (r) => { calls.push(r); return { content: [{ type: 'text', text: 'from claude' }], usage: { input_tokens: 5, output_tokens: 2 } }; } } }; };
  const params = { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], tools, tool_choice: 'auto', max_tokens: 500 };

  test('uses OpenAI while it works and never calls Claude', async () => {
    const oa = okOpenAi(); const an = claude();
    const res = await makeAgenticClient({ openai: oa, anthropic: an, env }).chat.completions.create(params);
    assert.equal(res.choices[0].message.content, 'from openai');
    assert.equal(an.calls.length, 0);
  });

  test('a quota error is answered by Claude, and later calls skip OpenAI entirely', async () => {
    const oa = quotaOpenAi(); const an = claude();
    const client = makeAgenticClient({ openai: oa, anthropic: an, env });
    const first = await client.chat.completions.create(params);
    assert.equal(first.choices[0].message.content, 'from claude');
    assert.equal(an.calls[0].tool_choice.type, 'auto');
    assert.equal(an.calls[0].model, 'claude-haiku-4-5'); // never the OpenAI model name
    assert.equal(llmFallbackState().active, true);
    await client.chat.completions.create(params);
    assert.equal(oa.calls.length, 1); // second call did not touch OpenAI
    assert.equal(an.calls.length, 2);
  });

  test('the final answer-now call (no tools) keeps the tools for Claude and forbids using them', async () => {
    const oa = quotaOpenAi(); const an = claude();
    const client = makeAgenticClient({ openai: oa, anthropic: an, env });
    await client.chat.completions.create(params);
    await client.chat.completions.create({ model: 'gpt-4o-mini', max_tokens: 500, messages: [
      ...params.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'content-gap', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
      { role: 'user', content: 'final answer now' },
    ] });
    const last = an.calls[1];
    assert.equal(last.tools.length, 2);
    assert.deepEqual(last.tool_choice, { type: 'none' });
  });

  test('another error (not quota) is thrown unchanged, so the caller still falls back to the legacy orchestrator', async () => {
    const boom = Object.assign(new Error('500 upstream'), { status: 500 });
    const oa = { chat: { completions: { create: async () => { throw boom; } } } };
    await assert.rejects(makeAgenticClient({ openai: oa, anthropic: claude(), env }).chat.completions.create(params), /500 upstream/);
  });

  test('without an Anthropic key a quota error is thrown as before', async () => {
    await assert.rejects(makeAgenticClient({ openai: quotaOpenAi(), env: { OPENAI_API_KEY: 'sk-real' } }).chat.completions.create(params), /spend limit/);
  });

  test('with only an Anthropic key the loop runs on Claude', async () => {
    const an = claude();
    const res = await makeAgenticClient({ anthropic: an, env: { ANTHROPIC_API_KEY: 'sk-ant-real' } }).chat.completions.create(params);
    assert.equal(res.choices[0].message.content, 'from claude');
  });
});
