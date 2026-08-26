import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandbox, destroySandbox, resolveScopedPath, readSandboxFile, writeSandboxFile,
  listSandboxFiles, runSandboxCommand, snapshotFiles, diffSnapshots,
} from './sandbox.js';

const sandboxes = [];
async function freshSandbox() {
  const sandbox = await createSandbox();
  sandboxes.push(sandbox);
  return sandbox;
}
after(async () => { await Promise.all(sandboxes.map(destroySandbox)); });

describe('resolveScopedPath — the one boundary standing in for a container', () => {
  test('a normal relative path resolves inside the sandbox root', async () => {
    const sandbox = await freshSandbox();
    const abs = resolveScopedPath(sandbox, 'a/b.js');
    assert.ok(abs.startsWith(sandbox.root));
  });

  test('a "../" escape is refused', async () => {
    const sandbox = await freshSandbox();
    assert.throws(() => resolveScopedPath(sandbox, '../../etc/passwd'), /outside the sandbox/);
  });

  test('an absolute path escape is refused', async () => {
    const sandbox = await freshSandbox();
    assert.throws(() => resolveScopedPath(sandbox, '/etc/passwd'), /outside the sandbox/);
  });

  test('a NUL byte in the path is refused', async () => {
    const sandbox = await freshSandbox();
    assert.throws(() => resolveScopedPath(sandbox, 'a\0b'), /invalid path/);
  });

  test('the root itself ("." or "") is allowed, for list_files', async () => {
    const sandbox = await freshSandbox();
    assert.doesNotThrow(() => resolveScopedPath(sandbox, '.'));
    assert.doesNotThrow(() => resolveScopedPath(sandbox, ''));
  });
});

describe('read/write/list within the sandbox', () => {
  test('write then read round-trips, creating parent directories as needed', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'a/b/c.txt', 'hello');
    assert.equal(await readSandboxFile(sandbox, 'a/b/c.txt'), 'hello');
  });

  test('reading a file that does not exist returns null, never throws', async () => {
    const sandbox = await freshSandbox();
    assert.equal(await readSandboxFile(sandbox, 'nope.txt'), null);
  });

  test('listSandboxFiles finds nested files and skips node_modules/.git', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'server/a.js', '');
    await writeSandboxFile(sandbox, 'server/lib/b.js', '');
    await writeSandboxFile(sandbox, 'node_modules/dep/index.js', '');
    const files = (await listSandboxFiles(sandbox, '.')).sort();
    assert.deepEqual(files, ['server/a.js', 'server/lib/b.js']);
  });
});

describe('runSandboxCommand — the allowlist is the safety boundary, not a container', () => {
  test('a command not in the allowlist is refused without ever spawning it', async () => {
    const sandbox = await freshSandbox();
    const result = await runSandboxCommand(sandbox, 'rm', ['-rf', '/'], { allowlist: ['node', 'npm'] });
    assert.equal(result.ok, false);
    assert.match(result.output, /not in this task's allowlist/);
  });

  test('a command IN the allowlist actually runs', async () => {
    const sandbox = await freshSandbox();
    const result = await runSandboxCommand(sandbox, 'node', ['--version'], { allowlist: ['node'] });
    assert.equal(result.ok, true);
    assert.match(result.output, /^v\d/);
  });

  test('args come from the caller (the task), never validated against the model — the allowlist only gates the command name', async () => {
    const sandbox = await freshSandbox();
    // node --check on a nonexistent file: still runs (args are the task's
    // own, e.g. a real file path it computed), just fails at the OS level.
    const result = await runSandboxCommand(sandbox, 'node', ['--check', 'does-not-exist.js'], { allowlist: ['node'] });
    assert.equal(result.ok, false);
  });
});

describe('snapshotFiles / diffSnapshots — the independent "what changed" check', () => {
  test('an unchanged file produces no diff entry', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'a.js', 'const x = 1;\n');
    const before = await snapshotFiles(sandbox, ['a.js']);
    const after = await snapshotFiles(sandbox, ['a.js']);
    assert.deepEqual(diffSnapshots(before, after), []);
  });

  test('a real edit produces a changed entry with a valid unified-diff patch', async () => {
    const sandbox = await freshSandbox();
    await writeSandboxFile(sandbox, 'a.js', 'const x = 1;\n');
    const before = await snapshotFiles(sandbox, ['a.js']);
    await writeSandboxFile(sandbox, 'a.js', 'const x = 2;\n');
    const after = await snapshotFiles(sandbox, ['a.js']);
    const [changed] = diffSnapshots(before, after);
    assert.equal(changed.path, 'a.js');
    assert.equal(changed.newContent, 'const x = 2;\n');
    assert.match(changed.patch, /^--- a\/a\.js/);
    assert.match(changed.patch, /\+\+\+ b\/a\.js/);
    assert.match(changed.patch, /-const x = 1;/);
    assert.match(changed.patch, /\+const x = 2;/);
  });

  test('a newly-created file (absent before) is reported as changed', async () => {
    const sandbox = await freshSandbox();
    const before = await snapshotFiles(sandbox, ['new.js']);
    await writeSandboxFile(sandbox, 'new.js', 'export const x = 1;\n');
    const after = await snapshotFiles(sandbox, ['new.js']);
    const [changed] = diffSnapshots(before, after);
    assert.equal(changed.path, 'new.js');
  });

  test('a deleted file (present before, absent after) is never reported — deletion is not auto-reported', async () => {
    const before = { 'a.js': 'x' };
    const after = { 'a.js': null };
    assert.deepEqual(diffSnapshots(before, after), []);
  });
});
