// Ports design_task.py's build_code_self_repair_task +
// _validate_code_self_repair into the native (no Docker) engine. Payload
// shape is UNCHANGED — server/agents/lib/code-self-repair.js's
// `investigateAndRepair` already builds exactly
// {generatorId, reason, errorMessage, occurrenceDays, testFileHint} and
// needs no changes to keep calling this.
import { listSandboxFiles, snapshotFiles, diffSnapshots, runSandboxCommand } from './sandbox.js';

const CODE_ROOT = 'server';
// package.json/package-lock.json are outside CODE_ROOT (repo root), so the
// write-tool's file-tree scope (below) never reaches them anyway; listed
// here too, in the prompt, for the same belt-and-suspenders reason
// design_task.py's own prompt calls them out explicitly alongside
// migrations/.
const FORBIDDEN_SUBSTRINGS = ['/migrations/', 'package.json', 'package-lock.json'];

export function buildCodeSelfRepairPrompt(payload) {
  const {
    generatorId = '(unknown generator)', reason = '(unknown reason)',
    errorMessage = '(no error message captured)', occurrenceDays, testFileHint,
  } = payload || {};

  const lines = [
    `This directory is a real, complete checkout of this platform's own application repository, on its integration `
      + `branch (${CODE_ROOT}/ is where all server-side code lives). This is a real code-editing task: use `
      + 'read_file/write_file to edit files, and run_command for the allowed commands.\n',
    `A generator/implementer with id "${generatorId}" has been failing or refusing with the same reason `
      + `("${reason}") on at least ${occurrenceDays || 2} separate calendar days, across real client sites. This is not `
      + 'a one-off — it is evidence of a real bug in the shared platform code itself, not in any one site\'s content.\n',
    `The error/detail captured from a real failed attempt: ${errorMessage}\n`,
    'Do NOT simply retry the original recommendation or generate new content — that is not your job here. Investigate '
      + `the ACTUAL PLATFORM IMPLEMENTATION: find the generator in ${CODE_ROOT}/generators/, the implementer/adapter in `
      + `${CODE_ROOT}/implementers/ (and any shared helper it calls) that this generator id and failure reason point to. `
      + 'Read the relevant code and its existing test file before changing anything.\n',
    'Identify the real root cause. Implement the SMALLEST safe fix — do not refactor, rename, or restructure anything '
      + 'beyond what the bug requires. Do not add speculative error handling, comments, or abstractions.\n',
  ];

  if (testFileHint) {
    lines.push(
      `Run the existing test file at ${testFileHint} with run_command (\`node --test ${testFileHint}\`) and confirm it `
      + 'passes after your fix. If you can write a small additional test case that reproduces the original bug, add it '
      + 'to that same file.\n',
    );
  } else {
    lines.push(
      'Find and run this code\'s existing test file(s) with run_command (`node --test <path>`) and confirm they pass '
      + 'after your fix. If no test file exists yet for the exact function you changed, add a small one next to the '
      + 'code, matching this repo\'s existing test style (node:test + node:assert/strict).\n',
    );
  }
  lines.push(
    `Only touch files under ${CODE_ROOT}/ — write_file will refuse anything else. Never touch `
    + `${CODE_ROOT}/migrations/, package.json, or package-lock.json.\n`,
  );
  lines.push(
    'When you are done, respond with ONLY a JSON object (no prose, no code fence) shaped exactly like:\n'
    + '{"summary": "<one sentence, what was wrong>", "rootCause": "<one or two sentences, the real cause>", "testsPassed": true or false}\n'
    + 'Report testsPassed truthfully — it will be checked independently either way, but a false claim here is worse than an honest failure.',
  );
  return lines.join('\n');
}

// write_file's own scope check (agent-loop.js) only enforces the CODE_ROOT
// boundary generically via listSandboxFiles below feeding the discovered
// file set — the migrations/package.json exclusions are enforced here, in
// validate(), as an explicit reject rather than a write-time refusal, since
// the write tool has no per-path allowlist for this open-scope task (a real
// bug fix can span any file under CODE_ROOT).
function isForbiddenPath(path) {
  return FORBIDDEN_SUBSTRINGS.some((s) => path.includes(s)) || !path.startsWith(`${CODE_ROOT}/`);
}

// Independent validation — never trusts the agent's own TerminalTool run or
// its self-reported testsPassed. Mirrors design_task.py's
// _validate_code_self_repair: node --check every changed file, then
// node --test on testFileHint or any changed *.test.js file; a fix with no
// test target at all is not validated, same as today.
export async function validateCodeSelfRepair(sandbox, { testFileHint }, beforeSnapshot) {
  const currentFiles = await listSandboxFiles(sandbox, CODE_ROOT);
  const after = await snapshotFiles(sandbox, [...new Set([...Object.keys(beforeSnapshot), ...currentFiles])]);
  const changed = diffSnapshots(beforeSnapshot, after).filter((c) => !isForbiddenPath(c.path));
  const forbidden = diffSnapshots(beforeSnapshot, after).filter((c) => isForbiddenPath(c.path));
  if (forbidden.length) {
    return { ok: false, output: `Agent touched forbidden file(s): ${forbidden.map((c) => c.path).join(', ')}` };
  }
  if (!changed.length) return { ok: false, output: 'Agent made no file changes.' };

  for (const entry of changed) {
    if (!entry.path.endsWith('.js') && !entry.path.endsWith('.mjs')) continue;
    // eslint-disable-next-line no-await-in-loop
    const check = await runSandboxCommand(sandbox, 'node', ['--check', entry.path], { allowlist: ['node'] });
    if (!check.ok) return { ok: false, output: `node --check failed for ${entry.path}:\n${check.output}` };
  }

  const testTargets = testFileHint ? [testFileHint] : changed.filter((c) => c.path.endsWith('.test.js')).map((c) => c.path);
  if (!testTargets.length) {
    return { ok: false, output: 'No test file available to validate against (no testFileHint, and the agent added no *.test.js file).' };
  }

  const outputs = [];
  for (const testPath of testTargets) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runSandboxCommand(sandbox, 'node', ['--test', testPath], { allowlist: ['node'], timeoutMs: 120_000 });
    outputs.push(`$ node --test ${testPath}\n${result.output}`);
    if (!result.ok) return { ok: false, output: outputs.join('\n\n') };
  }
  return { ok: true, output: outputs.join('\n\n'), filesChanged: changed, patch: changed.map((c) => c.patch).join('\n\n') };
}
