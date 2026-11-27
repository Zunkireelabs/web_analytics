import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from './agent-loop.js';
import { createSandbox, destroySandbox } from './sandbox.js';

const sandboxes = [];
async function freshSandbox() {
  const sandbox = await createSandbox();
  sandboxes.push(sandbox);
  return sandbox;
}
after(async () => { await Promise.all(sandboxes.map(destroySandbox)); });

// A minimal fake Anthropic client — `scriptedReplies` is an array of
// `{content}` response bodies (the shape `messages.create` returns),
// consumed in order across every call this loop makes, regardless of which
// "round" (fix-retry attempt) it's in — mirrors how the real conversation
// grows across rounds without needing a real API call.
function fakeAnthropic(scriptedReplies) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        if (i >= scriptedReplies.length) throw new Error('fakeAnthropic: ran out of scripted replies');
        return scriptedReplies[i++];
      },
    },
  };
}

function textBlock(text) { return { type: 'text', text }; }
function toolUseBlock(id, name, input) { return { type: 'tool_use', id, name, input }; }

describe('runAgentLoop — tool-use turns', () => {
  test('a tool_use turn is executed against the sandbox and its result fed back', async () => {
    const sandbox = await freshSandbox();
    const anthropic = fakeAnthropic([
      { content: [toolUseBlock('t1', 'write_file', { path: 'a.js', content: 'const x = 1;\n' })] },
      { content: [textBlock('{"summary": "wrote a.js"}')] },
    ]);
    const result = await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: ['node'],
      provider: 'anthropic',
      anthropicClient: anthropic,
      validate: async () => ({ ok: true, output: 'ok', filesChanged: [{ path: 'a.js', newContent: 'const x = 1;\n', patch: 'p' }] }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'wrote a.js');
    assert.equal(result.testsPassed, true);
  });

  test('a write_file call outside fileAllowlist is refused before touching disk', async () => {
    const sandbox = await freshSandbox();
    const anthropic = fakeAnthropic([
      { content: [toolUseBlock('t1', 'write_file', { path: 'OUT_OF_SCOPE.js', content: 'x' })] },
      { content: [textBlock('{"summary": "done"}')] },
    ]);
    let validateCalls = 0;
    await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: ['node'],
      fileAllowlist: ['allowed.js'],
      provider: 'anthropic',
      anthropicClient: anthropic,
      validate: async () => { validateCalls++; return { ok: false, output: 'nothing changed' }; },
    });
    const { readSandboxFile } = await import('./sandbox.js');
    assert.equal(await readSandboxFile(sandbox, 'OUT_OF_SCOPE.js'), null, 'the refused write must never reach disk');
  });

  test('exceeding maxTurns without the model finishing is a real, thrown-then-caught failure — never a false success', async () => {
    const sandbox = await freshSandbox();
    // Every scripted reply keeps requesting a tool — the loop never gets a
    // text-only "done" message, so it must hit maxTurns and report error.
    const replies = Array.from({ length: 5 }, (_, i) => ({ content: [toolUseBlock(`t${i}`, 'list_files', {})] }));
    const anthropic = fakeAnthropic(replies);
    const result = await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: [], maxTurns: 3, maxFixRounds: 0,
      provider: 'anthropic',
      anthropicClient: anthropic,
      validate: async () => ({ ok: true, output: 'unreachable' }),
    });
    assert.equal(result.status, 'error');
    assert.match(result.detail, /exceeded 3 turns/);
  });
});

describe('runAgentLoop — validation failure triggers the bounded fix-retry loop', () => {
  test('a failed validation feeds the failure back and gives the model another round', async () => {
    const sandbox = await freshSandbox();
    const anthropic = fakeAnthropic([
      { content: [textBlock('first attempt')] },
      { content: [textBlock('{"summary": "fixed it"}')] },
    ]);
    let validateCalls = 0;
    const result = await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: [], maxFixRounds: 1,
      provider: 'anthropic',
      anthropicClient: anthropic,
      validate: async () => {
        validateCalls++;
        return validateCalls === 1 ? { ok: false, output: 'tests failed' } : { ok: true, output: 'now passes', filesChanged: [] };
      },
    });
    assert.equal(validateCalls, 2);
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'fixed it');
  });

  test('exhausting every fix-retry round returns status:error, never a false ok', async () => {
    const sandbox = await freshSandbox();
    const anthropic = fakeAnthropic([
      { content: [textBlock('attempt 1')] },
      { content: [textBlock('attempt 2')] },
      { content: [textBlock('attempt 3')] },
    ]);
    const result = await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: [], maxFixRounds: 2,
      provider: 'anthropic',
      anthropicClient: anthropic,
      validate: async () => ({ ok: false, output: 'still broken' }),
    });
    assert.equal(result.status, 'error');
    assert.match(result.detail, /Validation failed after 3 attempt/);
    assert.equal(result.testOutput, 'still broken');
  });
});

// Real incident (2026-08-27): the loop was hardcoded to Anthropic with no
// fallback, so this deployment's first-ever production capability-repair
// run failed outright with "Could not resolve authentication method" —
// this environment only has a real OPENAI_API_KEY configured. This suite
// covers OpenAI's structurally different tool-calling wire shape
// (tool_calls / role:'tool' messages, not Anthropic's tool_use/tool_result
// content blocks) end to end, the same way the describes above cover
// Anthropic's.
function fakeOpenAiToolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// `scriptedReplies` is an array of `{content, tool_calls}` chat-completion
// message bodies, consumed in order — mirrors fakeAnthropic above for the
// OpenAI wire shape.
function fakeOpenAi(scriptedReplies) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= scriptedReplies.length) throw new Error('fakeOpenAi: ran out of scripted replies');
          return { choices: [{ message: scriptedReplies[i++] }] };
        },
      },
    },
  };
}

describe('runAgentLoop — OpenAI provider (structurally different tool-call wire shape)', () => {
  test('a tool_calls turn is executed against the sandbox and its result fed back as a role:tool message', async () => {
    const sandbox = await freshSandbox();
    const openai = fakeOpenAi([
      { content: null, tool_calls: [fakeOpenAiToolCall('t1', 'write_file', { path: 'a.js', content: 'const x = 1;\n' })] },
      { content: '{"summary": "wrote a.js"}', tool_calls: undefined },
    ]);
    const result = await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: ['node'],
      provider: 'openai',
      openaiClient: openai,
      validate: async () => ({ ok: true, output: 'ok', filesChanged: [{ path: 'a.js', newContent: 'const x = 1;\n', patch: 'p' }] }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'wrote a.js');
    assert.equal(result.testsPassed, true);
    const { readSandboxFile } = await import('./sandbox.js');
    assert.equal(await readSandboxFile(sandbox, 'a.js'), 'const x = 1;\n');
  });

  test('a write_file call outside fileAllowlist is refused before touching disk, same as the Anthropic path', async () => {
    const sandbox = await freshSandbox();
    const openai = fakeOpenAi([
      { content: null, tool_calls: [fakeOpenAiToolCall('t1', 'write_file', { path: 'OUT_OF_SCOPE.js', content: 'x' })] },
      { content: '{"summary": "done"}', tool_calls: undefined },
    ]);
    await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: ['node'],
      fileAllowlist: ['allowed.js'],
      provider: 'openai',
      openaiClient: openai,
      validate: async () => ({ ok: false, output: 'nothing changed' }),
    });
    const { readSandboxFile } = await import('./sandbox.js');
    assert.equal(await readSandboxFile(sandbox, 'OUT_OF_SCOPE.js'), null, 'the refused write must never reach disk');
  });

  test('a failed validation feeds the failure back and gives the model another round', async () => {
    const sandbox = await freshSandbox();
    const openai = fakeOpenAi([
      { content: 'first attempt', tool_calls: undefined },
      { content: '{"summary": "fixed it"}', tool_calls: undefined },
    ]);
    let validateCalls = 0;
    const result = await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: [], maxFixRounds: 1,
      provider: 'openai',
      openaiClient: openai,
      validate: async () => {
        validateCalls++;
        return validateCalls === 1 ? { ok: false, output: 'tests failed' } : { ok: true, output: 'now passes', filesChanged: [] };
      },
    });
    assert.equal(validateCalls, 2);
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'fixed it');
  });
});

import { isProviderLimitError } from './agent-loop.js';

describe('OpenAI limit -> carry on with Claude', () => {
  test('quota and rate-limit errors are recognised; ordinary errors are not', () => {
    for (const e of [{ status: 429 }, { code: 'insufficient_quota' }, { message: 'You exceeded your current quota' }, { message: 'Rate limit reached' }]) assert.equal(isProviderLimitError(e), true, JSON.stringify(e));
    for (const e of [{ status: 500, message: 'server error' }, { message: 'bad tool call' }, null]) assert.equal(isProviderLimitError(e), false);
  });
});

describe('runAgentLoop — OpenAI limit exceeded falls back to Claude for the SAME repair', () => {
  const env = { ...process.env };
  const restore = () => { for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NATIVE_REPAIR_PROVIDER']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } };
  const run = async (extra) => {
    const sandbox = await createSandbox();
    try {
      return await runAgentLoop({
        systemPrompt: 's', taskPrompt: 't', sandbox, allowlist: ['node'], validate: async () => ({ ok: true, output: 'ok', filesChanged: [] }), ...extra,
      });
    } finally { await destroySandbox(sandbox); }
  };
  const limited = { chat: { completions: { create: async () => { const e = new Error('You exceeded your current quota'); e.status = 429; throw e; } } } };
  const claude = (log) => ({ messages: { create: async () => { log.push('claude'); return { content: [{ type: 'text', text: '{"summary":"done by claude"}' }] }; } } });

  test('a 429 from OpenAI continues with Claude and reports it', async () => {
    process.env.OPENAI_API_KEY = 'sk-real-key'; process.env.ANTHROPIC_API_KEY = 'ant-key'; delete process.env.NATIVE_REPAIR_PROVIDER;
    try {
      const log = [];
      const r = await run({ openaiClient: limited, anthropicClient: claude(log) });
      assert.equal(r.status, 'ok');
      assert.equal(r.fellBackFrom, 'openai');
      assert.deepEqual(log, ['claude']);
    } finally { restore(); }
  });

  test('a PINNED provider is respected: no silent switch', async () => {
    process.env.OPENAI_API_KEY = 'sk-real-key'; process.env.ANTHROPIC_API_KEY = 'ant-key'; process.env.NATIVE_REPAIR_PROVIDER = 'openai';
    try {
      const log = [];
      const r = await run({ openaiClient: limited, anthropicClient: claude(log) });
      assert.equal(r.status, 'error');
      assert.deepEqual(log, []);
    } finally { restore(); }
  });

  test('a non-limit OpenAI error is NOT retried on Claude', async () => {
    process.env.OPENAI_API_KEY = 'sk-real-key'; process.env.ANTHROPIC_API_KEY = 'ant-key'; delete process.env.NATIVE_REPAIR_PROVIDER;
    try {
      const log = [];
      const broken = { chat: { completions: { create: async () => { throw new Error('malformed request'); } } } };
      const r = await run({ openaiClient: broken, anthropicClient: claude(log) });
      assert.equal(r.status, 'error');
      assert.deepEqual(log, []);
    } finally { restore(); }
  });

  test('with no Claude key available, the OpenAI limit is reported honestly, not hidden', async () => {
    process.env.OPENAI_API_KEY = 'sk-real-key'; delete process.env.ANTHROPIC_API_KEY; delete process.env.NATIVE_REPAIR_PROVIDER;
    try {
      const r = await run({ openaiClient: limited });
      assert.equal(r.status, 'error');
      assert.equal(r.limit, true);
    } finally { restore(); }
  });
});

// The worker provider: each turn is a text request, the tools still run HERE in the sandbox, and validate() still decides.
describe('runAgentLoop — worker provider (no paid API, text turns)', () => {
  const scripted = (replies) => { const seen = []; let i = 0; return { seen, complete: async (req) => { seen.push(req); if (i >= replies.length) throw new Error('ran out of replies'); return replies[i++]; } }; };

  test('a JSON action is run as a tool in the sandbox, its result goes into the next request, and "done" ends it', async () => {
    const sandbox = await freshSandbox();
    const worker = scripted([
      '{"tool": "write_file", "input": {"path": "w.js", "content": "const y = 2;\\n"}}',
      '```json\n{"done": true, "final": {"summary": "wrote w.js"}}\n```',
    ]);
    const result = await runAgentLoop({
      systemPrompt: 'sys', taskPrompt: 'task', sandbox, allowlist: ['node'], provider: 'worker', workerClient: worker,
      validate: async () => ({ ok: true, output: 'ok', filesChanged: [{ path: 'w.js', newContent: 'const y = 2;\n', patch: 'p' }] }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'wrote w.js');
    const { readSandboxFile } = await import('./sandbox.js');
    assert.equal(await readSandboxFile(sandbox, 'w.js'), 'const y = 2;\n');
    assert.match(worker.seen[0].system, /ONE JSON object/);
    assert.match(worker.seen[1].user, /TOOL RESULT for write_file/);
  });

  test('the file scope is still enforced: an out-of-scope write is refused and the model is told so', async () => {
    const sandbox = await freshSandbox();
    const worker = scripted(['{"tool": "write_file", "input": {"path": "OUT.js", "content": "x"}}', '{"done": true, "final": "{\\"summary\\": \\"d\\"}"}']);
    await runAgentLoop({
      systemPrompt: 's', taskPrompt: 't', sandbox, allowlist: ['node'], fileAllowlist: ['ok.js'], provider: 'worker', workerClient: worker,
      validate: async () => ({ ok: true, output: '', filesChanged: [] }),
    });
    assert.match(worker.seen[1].user, /Refused: this task may only write to ok\.js/);
  });

  test('the worker saying it is done changes nothing by itself: a failing validation sends it back for another round', async () => {
    const sandbox = await freshSandbox();
    const worker = scripted(['{"done": true, "final": {"summary": "one"}}', '{"done": true, "final": {"summary": "two"}}']);
    let n = 0;
    const result = await runAgentLoop({
      systemPrompt: 's', taskPrompt: 't', sandbox, allowlist: ['node'], provider: 'worker', workerClient: worker,
      validate: async () => (++n === 1 ? { ok: false, output: 'test failed' } : { ok: true, output: 'ok', filesChanged: [] }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.summary, 'two');
    assert.match(worker.seen[1].user, /Validation failed/);
  });

  test('worker offline: a clean error flagged workerUnavailable, no paid API', async () => {
    const sandbox = await freshSandbox();
    const offline = { complete: async () => { throw Object.assign(new Error('The Claude Code worker is not connected'), { workerUnavailable: true, status: 502 }); } };
    const result = await runAgentLoop({ systemPrompt: 's', taskPrompt: 't', sandbox, allowlist: ['node'], provider: 'worker', workerClient: offline, validate: async () => ({ ok: true }) });
    assert.equal(result.status, 'error');
    assert.equal(result.workerUnavailable, true);
    assert.equal(result.limit, false);
  });

  test('with the worker mode on and no provider pinned, the loop picks the worker, not a paid API', async () => {
    const { pickProvider } = await import('./agent-loop.js');
    const was = [process.env.LLM_WORKER_MODE, process.env.NATIVE_REPAIR_PROVIDER, process.env.LLM_WORKER_FALLBACK];
    process.env.LLM_WORKER_MODE = 'on'; delete process.env.NATIVE_REPAIR_PROVIDER; delete process.env.LLM_WORKER_FALLBACK;
    try { assert.equal(pickProvider(), 'worker'); } finally {
      for (const [k, v] of [['LLM_WORKER_MODE', was[0]], ['NATIVE_REPAIR_PROVIDER', was[1]], ['LLM_WORKER_FALLBACK', was[2]]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
