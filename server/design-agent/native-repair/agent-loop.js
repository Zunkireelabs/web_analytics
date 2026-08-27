// The native (no Docker, no OpenHands) code-editing agent loop — replaces
// design_task.py's OpenHands Agent/Conversation for capability-repair and
// code-self-repair. A plain tool-use loop, operating on a sandbox.js
// workspace instead of a container.
//
// Provider is chosen the SAME way server/llm.js already picks one for
// every other generator (a real OPENAI_API_KEY -> OpenAI, else Anthropic;
// force with NATIVE_REPAIR_PROVIDER=openai|anthropic) — not imported from
// llm.js directly, since that module's top-level `import OpenAI`/`import
// Anthropic` would still run either way, but llm.js ALSO eagerly imports
// agent-memory.js/design-drift.js's much heavier graph (github client,
// db, ...) that this module (loaded by code-self-repair.js, in turn loaded
// by auto-remediation.js) has no reason to pull in just to read two env
// vars. Kept in sync with llm.js's pickProvider by hand, same discipline
// this file's own extractJson already uses for the same reason.
// Real incident this fixes: 2026-08-27's first-ever production
// capability-repair run failed outright with "Could not resolve
// authentication method" — this deployment only has a real OPENAI_API_KEY
// configured, but the loop was hardcoded to Anthropic with no fallback.
import Anthropic from '@anthropic-ai/sdk';
import { readSandboxFile, writeSandboxFile, listSandboxFiles, runSandboxCommand } from './sandbox.js';

function pickProvider() {
  if (process.env.NATIVE_REPAIR_PROVIDER) return process.env.NATIVE_REPAIR_PROVIDER.toLowerCase();
  const oa = process.env.OPENAI_API_KEY;
  if (oa && !oa.startsWith('sk-xxxx')) return 'openai';
  return 'anthropic';
}

const DEFAULT_MODEL = {
  openai: process.env.NATIVE_REPAIR_MODEL_OPENAI || 'gpt-4o',
  anthropic: process.env.NATIVE_REPAIR_MODEL || 'claude-opus-4-8',
};
const MAX_TOKENS = 4096;

// Same lenient JSON extraction as server/llm.js's extractJson (strip a
// markdown code fence, then fall back to the widest {...}/[...] substring)
// — duplicated rather than imported, deliberately: llm.js has a static,
// eager `import OpenAI from 'openai'` at its top, and this module (loaded
// by server/agents/lib/code-self-repair.js, in turn loaded by
// auto-remediation.js) would otherwise pull that whole SDK in just for
// this one small helper. Keep in sync with llm.js's version if that logic
// ever changes.
function extractJson(raw) {
  const stripped = (raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const firstBrace = stripped.search(/[{[]/);
  const lastBrace = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'));
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  try { return JSON.parse(stripped.slice(firstBrace, lastBrace + 1)); } catch { return null; }
}

// One declarative tool vocabulary, mapped to each provider's own wire shape
// below — never two separately-maintained tool lists that could drift.
const TOOL_DEFS = [
  {
    name: 'read_file',
    description: 'Read a file, path relative to the repo root. Returns "File does not exist." if it is absent.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write (overwrite) a file, path relative to the repo root. Creates parent directories as needed.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'list_files',
    description: 'List every file under a directory, path relative to the repo root, recursively (skips node_modules/.git).',
    parameters: { type: 'object', properties: { dir: { type: 'string' } } },
  },
  {
    name: 'run_command',
    description: 'Run one of the commands this task allows (see the task instructions for exactly which). Any other command is refused.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
      required: ['command'],
    },
  },
];

function buildTools(provider) {
  if (provider === 'openai') {
    return TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  return TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

async function executeTool(sandbox, toolName, input, { allowlist, fileAllowlist }) {
  switch (toolName) {
    case 'read_file': {
      const content = await readSandboxFile(sandbox, input.path);
      return content === null ? 'File does not exist.' : content;
    }
    case 'write_file': {
      // The tool-level half of the "only touch these files" guarantee —
      // refused BEFORE the write happens, not just caught after by the
      // task's validate() step. `fileAllowlist` is null for tasks with no
      // fixed scope (code-self-repair, where a real bug fix can span
      // files) — path containment (sandbox.js's resolveScopedPath) is
      // still enforced either way.
      if (Array.isArray(fileAllowlist) && !fileAllowlist.includes(input.path)) {
        return `Refused: this task may only write to ${fileAllowlist.join(', ')} — "${input.path}" is out of scope.`;
      }
      await writeSandboxFile(sandbox, input.path, input.content ?? '');
      return `Wrote ${input.path} (${(input.content || '').length} bytes).`;
    }
    case 'list_files': {
      const files = await listSandboxFiles(sandbox, input.dir || '.');
      return files.join('\n') || '(empty)';
    }
    case 'run_command': {
      const result = await runSandboxCommand(sandbox, input.command, input.args || [], { allowlist });
      return `exit ${result.ok ? 0 : 1}\n${result.output}`;
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// Sends one turn to the model and normalizes the reply to a provider-agnostic
// shape: { text, toolCalls: [{id, name, input}], rawMessage } — rawMessage
// is the provider's own assistant message, appended to `messages` verbatim
// by the caller (each provider's own wire format for "what the assistant
// said" differs and must round-trip exactly for the next turn to parse).
async function callModel({ provider, client, model, systemPrompt, tools, messages }) {
  if (provider === 'openai') {
    const res = await client.chat.completions.create({
      model, max_tokens: MAX_TOKENS, tools,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    });
    const choice = res.choices[0]?.message;
    const toolCalls = (choice?.tool_calls || []).map((tc) => ({
      id: tc.id, name: tc.function.name, input: extractJson(tc.function.arguments) || {},
    }));
    return { text: choice?.content || '', toolCalls, rawMessage: { role: 'assistant', content: choice?.content ?? null, tool_calls: choice?.tool_calls } };
  }

  const res = await client.messages.create({ model, max_tokens: MAX_TOKENS, system: systemPrompt, tools, messages });
  const toolCalls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, toolCalls, rawMessage: { role: 'assistant', content: res.content } };
}

// Appends this turn's assistant message and its tool results onto
// `messages`, in whichever shape `provider` requires for the NEXT call to
// parse them correctly — OpenAI wants one flat `{role:'tool', tool_call_id}`
// message per call; Anthropic wants one `{role:'user', content:[...]}`
// message wrapping every tool_result block from this turn together.
function appendToolTurn(provider, messages, rawMessage, toolCalls, results) {
  messages.push(rawMessage);
  if (provider === 'openai') {
    for (let i = 0; i < toolCalls.length; i++) {
      messages.push({ role: 'tool', tool_call_id: toolCalls[i].id, content: results[i] });
    }
  } else {
    messages.push({
      role: 'user',
      content: toolCalls.map((tc, i) => ({ type: 'tool_result', tool_use_id: tc.id, content: results[i] })),
    });
  }
}

// One bounded conversation: keeps calling the model and executing whatever
// tools it requests until it stops requesting them (done) or `maxTurns` is
// hit (a real, thrown failure — an agent that never converges is not a
// "close enough" success). Returns the model's final plain-text message.
async function runTurns({ provider, client, model, systemPrompt, tools, messages, sandbox, allowlist, fileAllowlist, maxTurns }) {
  for (let turn = 0; turn < maxTurns; turn++) {
    // eslint-disable-next-line no-await-in-loop
    const { text, toolCalls, rawMessage } = await callModel({ provider, client, model, systemPrompt, tools, messages });
    if (!toolCalls.length) return text;

    const results = [];
    for (const tc of toolCalls) {
      let resultText;
      try {
        // eslint-disable-next-line no-await-in-loop
        resultText = await executeTool(sandbox, tc.name, tc.input, { allowlist, fileAllowlist });
      } catch (err) {
        resultText = `Error: ${err.message}`;
      }
      results.push(String(resultText).slice(0, 8000));
    }
    appendToolTurn(provider, messages, rawMessage, toolCalls, results);
  }
  const err = new Error(`Agent loop exceeded ${maxTurns} turns without finishing.`);
  err.stage = 'agent_run';
  err.timedOut = true;
  throw err;
}

// `validate` is called with no arguments after each round of turns and must
// return `{ ok, output, filesChanged, patch }` — the SAME independent,
// never-trust-the-agent check design_task.py's _validate_capability_repair/
// _validate_code_self_repair perform, just invoked from JS. `taskPrompt`
// should already tell the model what final-message JSON shape to respond
// with (parsed here via server/llm.js's shared extractJson, same lenient
// fence-stripping every other generator already gets).
export async function runAgentLoop({
  systemPrompt, taskPrompt, sandbox, allowlist, fileAllowlist = null, maxTurns = 20, maxFixRounds = 2,
  validate, model, anthropicClient, openaiClient, provider: providerOverride,
}) {
  // Explicit override takes precedence over env auto-detection — lets a
  // caller that already knows which client it's injecting (every test in
  // agent-loop.test.js) stay deterministic regardless of which real API key
  // happens to be configured in the environment it runs in, rather than
  // silently ignoring a supplied anthropicClient/openaiClient because
  // pickProvider() resolved to the other one.
  const provider = providerOverride || pickProvider();
  // 'openai' is imported dynamically, only on this branch, so that every
  // caller of this module that never actually needs OpenAI (the Anthropic
  // path, or any test injecting its own openaiClient) never pulls in
  // 'openai''s own dependency graph at all — a real regression this fixed:
  // 'openai' transitively pulls in formdata-node, whose own dependency
  // web-streams-polyfill fails to load under this repo's Node version
  // (confirmed pre-existing and already broken elsewhere, e.g.
  // generators/faq.test.js's own import chain) — a static top-level
  // `import OpenAI from 'openai'` here made that failure newly reachable
  // from every test that imports this module transitively (e.g.
  // auto-remediation.test.js), even ones that only ever exercise the
  // Anthropic path.
  const client = provider === 'openai'
    ? (openaiClient || new (await import('openai')).default({ apiKey: process.env.OPENAI_API_KEY }))
    : (anthropicClient || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
  const resolvedModel = model || DEFAULT_MODEL[provider];
  const tools = buildTools(provider);
  const messages = [{ role: 'user', content: taskPrompt }];

  for (let round = 0; round <= maxFixRounds; round++) {
    let finalText;
    try {
      // eslint-disable-next-line no-await-in-loop
      finalText = await runTurns({ provider, client, model: resolvedModel, systemPrompt, tools, messages, sandbox, allowlist, fileAllowlist, maxTurns });
    } catch (err) {
      return { status: 'error', detail: err.message, stage: err.stage || 'agent_run' };
    }

    // eslint-disable-next-line no-await-in-loop
    const validation = await validate();
    if (validation.ok) {
      const parsed = extractJson(finalText) || {};
      return {
        status: 'ok',
        ...parsed,
        testsPassed: true,
        testOutput: validation.output,
        filesChanged: validation.filesChanged || [],
        patch: validation.patch || (validation.filesChanged || []).map((f) => f.patch).join('\n\n'),
      };
    }
    if (round === maxFixRounds) {
      return {
        status: 'error',
        detail: `Validation failed after ${round + 1} attempt(s): ${validation.output}`,
        testOutput: validation.output,
      };
    }
    messages.push({ role: 'user', content: `Validation failed:\n${String(validation.output).slice(0, 4000)}\n\nFix the problem and try again.` });
  }
  // Unreachable — the loop above always returns.
  return { status: 'error', detail: 'Agent loop exhausted without a result.' };
}
