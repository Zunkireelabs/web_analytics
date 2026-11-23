import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The OpenAI streaming path through the REAL openai SDK, not a hand-written fake: a local HTTP server answers the way OpenAI's API
// does (server-sent "chat.completion.chunk" events, a final usage chunk, "data: [DONE]"), and the SDK is pointed at it with
// OPENAI_BASE_URL. This is what proves llm-stream.js reads real SDK chunks correctly (text deltas, tool calls that arrive in
// fragments, usage), which the fake clients in llm-stream.test.js cannot.

let server; let base; let lastRequest; let script;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish = null) => sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', choices: [{ index: 0, delta, finish_reason: finish }] });

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      lastRequest = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const part of script) {
        if (part === 'HANG') { await new Promise((r) => setTimeout(r, 5000)); break; } // a stalled stream, for the abort test
        res.write(part);
        await new Promise((r) => setTimeout(r, 5));
      }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.OPENAI_BASE_URL = base; // read by the SDK when the client is created
});
after(async () => { delete process.env.OPENAI_BASE_URL; server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

const ENV = { OPENAI_API_KEY: 'sk-test-key' }; // no ANTHROPIC key: no fallback, no Claude
const { streamChat } = await import('./llm-stream.js');

describe('streamChat through the real OpenAI SDK', () => {
  test('streams text pieces in order, returns the whole text, and sends a correct streaming request', async () => {
    script = [chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hello' }), chunk({ content: ', ' }), chunk({ content: 'world' }), chunk({}, 'stop'),
      sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }), 'data: [DONE]\n\n'];
    const seen = [];
    const r = await streamChat({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], onText: (t) => seen.push(t) }, { env: ENV });
    assert.deepEqual(seen, ['Hello', ', ', 'world']);
    assert.equal(r.text, 'Hello, world');
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.provider, 'openai');
    assert.equal(lastRequest.url, '/v1/chat/completions');
    assert.equal(lastRequest.auth, 'Bearer sk-test-key');
    assert.equal(lastRequest.body.stream, true);
    assert.deepEqual(lastRequest.body.stream_options, { include_usage: true });
    assert.deepEqual(lastRequest.body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
    assert.equal(lastRequest.body.model, 'gpt-4o-mini');
    assert.equal(lastRequest.body.tools, undefined);
  });

  test('assembles a tool call the SDK delivers in fragments, and sends the tool definitions', async () => {
    const tc = (index, fn, extra = {}) => chunk({ tool_calls: [{ index, ...extra, function: fn }] });
    script = [
      chunk({ role: 'assistant', content: null }),
      tc(0, { name: 'get_pr_activity', arguments: '' }, { id: 'call_abc', type: 'function' }),
      tc(0, { arguments: '{"peri' }), tc(0, { arguments: 'od":"yest' }), tc(0, { arguments: 'erday"}' }),
      tc(1, { name: 'get_needs_you', arguments: '' }, { id: 'call_def', type: 'function' }),
      tc(1, { arguments: '{}' }),
      chunk({}, 'tool_calls'), 'data: [DONE]\n\n',
    ];
    const tools = [{ type: 'function', function: { name: 'get_pr_activity', description: 'd', parameters: { type: 'object', properties: {} } } }];
    const r = await streamChat({ system: 's', messages: [{ role: 'user', content: 'any PR yesterday?' }], tools }, { env: ENV });
    assert.deepEqual(r.toolCalls, [{ id: 'call_abc', name: 'get_pr_activity', args: { period: 'yesterday' } }, { id: 'call_def', name: 'get_needs_you', args: {} }]);
    assert.equal(r.text, '');
    assert.equal(lastRequest.body.tools[0].function.name, 'get_pr_activity');
  });

  test('a tool result is sent back in the format OpenAI expects', async () => {
    script = [chunk({ content: 'ok' }), chunk({}, 'stop'), 'data: [DONE]\n\n'];
    await streamChat({
      system: 's',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_needs_you', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_abc', content: '{"total":0}' },
      ],
    }, { env: ENV });
    const roles = lastRequest.body.messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool']);
    assert.equal(lastRequest.body.messages[3].tool_call_id, 'call_abc');
  });

  test('aborting mid-stream stops the call and rejects', async () => {
    script = [chunk({ content: 'Partial' }), 'HANG'];
    const controller = new AbortController();
    const seen = [];
    const p = streamChat({ system: 's', messages: [{ role: 'user', content: 'q' }], signal: controller.signal, onText: (t) => { seen.push(t); controller.abort(); } }, { env: ENV });
    await assert.rejects(p, (e) => /abort/i.test(`${e?.name} ${e?.message}`));
    assert.deepEqual(seen, ['Partial']);
  });

  test('an API error is thrown, and a quota error with no Claude key is not swallowed', async () => {
    const quota = http.createServer((req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } })); });
    await new Promise((r) => quota.listen(0, '127.0.0.1', r));
    const prev = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${quota.address().port}/v1`;
    try {
      await assert.rejects(streamChat({ system: 's', messages: [{ role: 'user', content: 'q' }] }, { env: ENV }), (e) => e.status === 429);
    } finally {
      process.env.OPENAI_BASE_URL = prev;
      quota.closeAllConnections?.(); await new Promise((r) => quota.close(r));
    }
  });
});
