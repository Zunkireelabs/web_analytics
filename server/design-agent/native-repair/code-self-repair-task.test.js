import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, destroySandbox, writeSandboxFile, snapshotFiles, listSandboxFiles } from './sandbox.js';
import { buildCodeSelfRepairPrompt, validateCodeSelfRepair } from './code-self-repair-task.js';

const sandboxes = [];
async function freshSandbox() {
  const sandbox = await createSandbox();
  sandboxes.push(sandbox);
  return sandbox;
}
after(async () => { await Promise.all(sandboxes.map(destroySandbox)); });
async function snapshotServerTree(sandbox) {
  return snapshotFiles(sandbox, await listSandboxFiles(sandbox, 'server'));
}

describe('buildCodeSelfRepairPrompt', () => {
  test('names the real evidence (generatorId, reason, error, occurrence days)', () => {
    const prompt = buildCodeSelfRepairPrompt({
      generatorId: 'faq', reason: 'invalid-json', errorMessage: 'Unexpected token', occurrenceDays: 3,
    });
    assert.match(prompt, /"faq"/);
    assert.match(prompt, /"invalid-json"/);
    assert.match(prompt, /Unexpected token/);
    assert.match(prompt, /3 separate calendar days/);
  });

  test('includes the testFileHint command when given, and the discover-your-own-test instruction otherwise', () => {
    const withHint = buildCodeSelfRepairPrompt({ generatorId: 'x', reason: 'y', testFileHint: 'server/generators/faq.test.js' });
    assert.match(withHint, /node --test server\/generators\/faq\.test\.js/);

    const withoutHint = buildCodeSelfRepairPrompt({ generatorId: 'x', reason: 'y' });
    assert.match(withoutHint, /Find and run this code's existing test file/);
  });
});

describe('validateCodeSelfRepair — never trusts the agent, real evidence only', () => {
  test('no changes at all fails validation', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'server/generators/faq.js', 'export function x() {}\n');
    const before = await snapshotServerTree(sandbox);
    const result = await validateCodeSelfRepair(sandbox, { testFileHint: null }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /made no file changes/);
  });

  test('touching a forbidden path (migrations/, package.json) fails validation', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'server/generators/faq.js', 'export function x() {}\n');
    const before = await snapshotServerTree(sandbox);
    await writeSandboxFile(sandbox, 'server/migrations/099_evil.sql', 'DROP TABLE users;');
    const result = await validateCodeSelfRepair(sandbox, { testFileHint: null }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /forbidden file/);
  });

  test('a syntactically invalid changed file fails node --check before any test runs', async () => {
    const sandbox = await freshSandbox();
    // node --check treats a bare .js file as CommonJS (lenient about a
    // top-level `export`) unless the repo declares itself an ES module —
    // matching the real platform repo's own package.json ("type": "module")
    // so this test reflects what --check actually does against a real
    // checkout, not an artificially permissive one.
    await writeSandboxFile(sandbox, 'package.json', JSON.stringify({ type: 'module' }));
    await writeSandboxFile(sandbox, 'server/generators/faq.js', 'export function x() {}\n');
    const before = await snapshotServerTree(sandbox);
    await writeSandboxFile(sandbox, 'server/generators/faq.js', 'export function x() {\n  const y = ;\n}\n');
    const result = await validateCodeSelfRepair(sandbox, { testFileHint: null }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /node --check failed/);
  });

  test('no test target at all (no hint, no *.test.js touched) fails honestly — never silently "passes"', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'server/generators/faq.js', 'export function x() { return 1; }\n');
    const before = await snapshotServerTree(sandbox);
    await writeSandboxFile(sandbox, 'server/generators/faq.js', 'export function x() { return 2; }\n');
    const result = await validateCodeSelfRepair(sandbox, { testFileHint: null }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /No test file available/);
  });

  test('a genuinely passing test with a real fix validates ok, carrying real filesChanged/patch', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'server/generators/x.js', 'export function add(a, b) { return a - b; }\n');
    await writeSandboxFile(
      sandbox, 'server/generators/x.test.js',
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './x.js';\n"
      + "test('adds', () => { assert.equal(add(1, 2), 3); });\n",
    );
    const before = await snapshotServerTree(sandbox);
    await writeSandboxFile(sandbox, 'server/generators/x.js', 'export function add(a, b) { return a + b; }\n');
    const result = await validateCodeSelfRepair(sandbox, { testFileHint: 'server/generators/x.test.js' }, before);
    assert.equal(result.ok, true);
    assert.equal(result.filesChanged.length, 1);
    assert.equal(result.filesChanged[0].path, 'server/generators/x.js');
    assert.match(result.patch, /\+export function add\(a, b\) \{ return a \+ b; \}/);
  });

  test('a still-failing test fails validation, real output included', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'server/generators/x.js', 'export function add(a, b) { return a - b; }\n');
    await writeSandboxFile(
      sandbox, 'server/generators/x.test.js',
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './x.js';\n"
      + "test('adds', () => { assert.equal(add(1, 2), 3); });\n",
    );
    const before = await snapshotServerTree(sandbox);
    await writeSandboxFile(sandbox, 'server/generators/x.js', 'export function add(a, b) { return a - b - 1; }\n');
    const result = await validateCodeSelfRepair(sandbox, { testFileHint: 'server/generators/x.test.js' }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /node --test/);
  });
});
