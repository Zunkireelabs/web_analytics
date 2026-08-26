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
      anthropicClient: anthropic,
      validate: async () => ({ ok: false, output: 'still broken' }),
    });
    assert.equal(result.status, 'error');
    assert.match(result.detail, /Validation failed after 3 attempt/);
    assert.equal(result.testOutput, 'still broken');
  });
});
