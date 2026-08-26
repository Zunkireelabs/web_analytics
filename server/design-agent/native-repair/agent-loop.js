// The native (no Docker, no OpenHands) code-editing agent loop — replaces
// design_task.py's OpenHands Agent/Conversation for capability-repair and
// code-self-repair. A plain tool-use loop against @anthropic-ai/sdk
// (already a dependency, already used by server/llm.js), operating on a
// sandbox.js workspace instead of a container.
//
// The independent validation step (`validate`, supplied by the caller —
// capability-repair-task.js / code-self-repair-task.js) is what makes this
// safe to trust: the loop NEVER returns status:'ok' on the model's own
// final message alone. On a validation failure, the failure output is fed
// back as a new turn and the model gets up to `maxFixRounds` more attempts
// to fix it — the "fix failures" step of the detect -> edit -> test -> fix
// -> PR loop, and a real improvement over the OpenHands path's one-shot
// (only retried by an external, next-day cron pass).
import Anthropic from '@anthropic-ai/sdk';
import { readSandboxFile, writeSandboxFile, listSandboxFiles, runSandboxCommand } from './sandbox.js';

const DEFAULT_MODEL = process.env.NATIVE_REPAIR_MODEL || 'claude-opus-4-8';
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

function buildTools() {
  return [
    {
      name: 'read_file',
      description: 'Read a file, path relative to the repo root. Returns "File does not exist." if it is absent.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'write_file',
      description: 'Write (overwrite) a file, path relative to the repo root. Creates parent directories as needed.',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    {
      name: 'list_files',
      description: 'List every file under a directory, path relative to the repo root, recursively (skips node_modules/.git).',
      input_schema: { type: 'object', properties: { dir: { type: 'string' } } },
    },
    {
      name: 'run_command',
      description: 'Run one of the commands this task allows (see the task instructions for exactly which). Any other command is refused.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
        required: ['command'],
      },
    },
  ];
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

// One bounded conversation: keeps calling the model and executing whatever
// tools it requests until it stops requesting them (done) or `maxTurns` is
// hit (a real, thrown failure — an agent that never converges is not a
// "close enough" success). Returns the model's final plain-text message.
async function runTurns({ anthropic, model, systemPrompt, tools, messages, sandbox, allowlist, fileAllowlist, maxTurns }) {
  for (let turn = 0; turn < maxTurns; turn++) {
    // eslint-disable-next-line no-await-in-loop
    const response = await anthropic.messages.create({
      model, max_tokens: MAX_TOKENS, system: systemPrompt, tools, messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      return response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    }

    const toolResults = [];
    for (const tu of toolUses) {
      let resultText;
      try {
        // eslint-disable-next-line no-await-in-loop
        resultText = await executeTool(sandbox, tu.name, tu.input, { allowlist, fileAllowlist });
      } catch (err) {
        resultText = `Error: ${err.message}`;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: String(resultText).slice(0, 8000) });
    }
    messages.push({ role: 'user', content: toolResults });
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
  validate, model = DEFAULT_MODEL, anthropicClient,
}) {
  const anthropic = anthropicClient || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tools = buildTools();
  const messages = [{ role: 'user', content: taskPrompt }];

  for (let round = 0; round <= maxFixRounds; round++) {
    let finalText;
    try {
      // eslint-disable-next-line no-await-in-loop
      finalText = await runTurns({ anthropic, model, systemPrompt, tools, messages, sandbox, allowlist, fileAllowlist, maxTurns });
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
