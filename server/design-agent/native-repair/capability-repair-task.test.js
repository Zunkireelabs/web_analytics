import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, destroySandbox, writeSandboxFile, snapshotFiles, listSandboxFiles } from './sandbox.js';
import { buildCapabilityRepairPrompt, validateCapabilityRepair } from './capability-repair-task.js';

const sandboxes = [];
async function freshSandbox() {
  const sandbox = await createSandbox();
  sandboxes.push(sandbox);
  return sandbox;
}
after(async () => { await Promise.all(sandboxes.map(destroySandbox)); });

// Mirrors native-repair-handler.js's own before-snapshot: the whole repo
// tree, not just the two allowed paths — that's what makes the
// out-of-scope-edit check in validateCapabilityRepair a real second gate.
async function snapshotWholeTree(sandbox) {
  return snapshotFiles(sandbox, await listSandboxFiles(sandbox, '.'));
}

describe('buildCapabilityRepairPrompt', () => {
  test('includes only real payload evidence — the fallback minimal-shape instructions when no convention example exists', () => {
    const prompt = buildCapabilityRepairPrompt({
      generatorId: 'expand-content', valueKey: 'expandedContent',
      templatePath: 'src/location.njk', templateSource: '<h1>{{ location.name }}</h1>',
      dataFilePath: 'src/_data/locations.js', dataFileSource: 'module.exports = [];',
      conventionExamples: [],
    });
    assert.match(prompt, /src\/location\.njk/);
    assert.match(prompt, /has no existing example of this convention/);
    assert.match(prompt, /AI-managed: server\/generators\/expand-content\.js/);
  });

  test('uses a real convention example verbatim when one is supplied, never the fallback shape', () => {
    const prompt = buildCapabilityRepairPrompt({
      generatorId: 'faq', valueKey: 'faqItems', templatePath: 'a.njk', templateSource: '',
      dataFilePath: 'b.js', dataFileSource: '',
      conventionExamples: [{ path: 'other.njk', snippet: '{# AI-managed: server/generators/faq.js #}' }],
    });
    assert.match(prompt, /From other\.njk/);
    assert.doesNotMatch(prompt, /has no existing example/);
  });
});

describe('validateCapabilityRepair — never trusts the agent, real evidence only', () => {
  test('no file changes at all fails validation', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'a.njk', 'X');
    await writeSandboxFile(sandbox, 'b.js', 'Y');
    const before = await snapshotWholeTree(sandbox);
    const result = await validateCapabilityRepair(sandbox, { templatePath: 'a.njk', dataFilePath: 'b.js' }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /made no file changes/);
  });

  test('a touched file outside the two-file allowlist fails, even if the allowed files also changed', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'a.njk', 'X');
    await writeSandboxFile(sandbox, 'b.js', 'module.exports = [];');
    const before = await snapshotWholeTree(sandbox);
    await writeSandboxFile(sandbox, 'a.njk', 'X changed');
    await writeSandboxFile(sandbox, 'c.njk', 'sneaky edit');
    const result = await validateCapabilityRepair(sandbox, { templatePath: 'a.njk', dataFilePath: 'b.js' }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /outside the intended scope/);
    assert.match(result.output, /c\.njk/);
  });

  test('invalid JSON in a .json data file fails validation before any build attempt', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'a.njk', 'X');
    await writeSandboxFile(sandbox, 'b.json', '[]');
    const before = await snapshotWholeTree(sandbox);
    await writeSandboxFile(sandbox, 'b.json', '{not valid json');
    const result = await validateCapabilityRepair(sandbox, { templatePath: 'a.njk', dataFilePath: 'b.json' }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /not valid JSON/);
  });

  test('no "build" script in package.json fails honestly rather than guessing a command', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'a.njk', 'X');
    await writeSandboxFile(sandbox, 'b.js', 'module.exports = [];');
    await writeSandboxFile(sandbox, 'package.json', JSON.stringify({ scripts: {} }));
    const before = await snapshotWholeTree(sandbox);
    await writeSandboxFile(sandbox, 'a.njk', 'X changed');
    const result = await validateCapabilityRepair(sandbox, { templatePath: 'a.njk', dataFilePath: 'b.js' }, before);
    assert.equal(result.ok, false);
    assert.match(result.output, /refusing to guess a build command/);
  });
});
