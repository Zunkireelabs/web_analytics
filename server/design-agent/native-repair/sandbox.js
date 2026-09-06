// A scoped, container-free workspace for the native repair agent loop —
// the replacement for design_task.py's DockerWorkspace. There is no
// process/namespace boundary here; the safety properties a container used
// to provide are enforced structurally instead:
//   - every file operation resolves its path and refuses anything that
//     would land outside this one temp directory (resolveScopedPath)
//   - every command run is checked against an explicit allowlist the TASK
//     supplies, never a string taken directly from the model
//   - the whole directory is deleted in a `finally` by the caller, win or
//     lose, same as openhands-handler.js's own workspaceDir cleanup
import { mkdtemp, rm, readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkoutRepoTarball } from '../repo-checkout.js';

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export async function createSandbox(prefix = 'native-repair-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { root };
}

export async function destroySandbox(sandbox) {
  if (!sandbox?.root) return;
  await rm(sandbox.root, { recursive: true, force: true });
}

// Checks out a real repo (a `site` row, or code-self-repair.js's
// PLATFORM_REPO descriptor — both already accepted by checkoutRepoTarball,
// which only ever required repo_owner/repo_name/repo_default_branch) into
// a fresh sandbox. Docker-free — checkoutRepoTarball is a plain tarball
// download + extract, same one the live-site analysis path's
// live-analysis-handler.js never even needed to touch.
export async function checkoutIntoSandbox(repo, { ref } = {}) {
  const sandbox = await createSandbox();
  await checkoutRepoTarball(repo, sandbox.root, { ref });
  return sandbox;
}

// The one thing standing between "the agent asked to write X" and "X
// actually gets written" now that there's no container boundary behind it.
// Rejects `..`/absolute escapes and embedded NUL bytes; the root itself
// (relPath === '' or '.') is allowed, since list_files may ask for it.
export function resolveScopedPath(sandbox, relPath) {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw new Error(`Refusing to touch an invalid path: ${JSON.stringify(relPath)}`);
  }
  const abs = resolve(sandbox.root, relPath || '.');
  if (abs !== sandbox.root && !abs.startsWith(sandbox.root + sep)) {
    throw new Error(`Refusing to touch a path outside the sandbox root: ${relPath}`);
  }
  return abs;
}

export async function readSandboxFile(sandbox, relPath) {
  const abs = resolveScopedPath(sandbox, relPath);
  try {
    return await fsReadFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeSandboxFile(sandbox, relPath, content) {
  const abs = resolveScopedPath(sandbox, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await fsWriteFile(abs, content ?? '', 'utf8');
}

const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git']);

export async function listSandboxFiles(sandbox, relDir = '.', { skipDirs = DEFAULT_SKIP_DIRS, limit = 2000 } = {}) {
  const startAbs = resolveScopedPath(sandbox, relDir);
  const out = [];
  async function walk(dirAbs) {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        // eslint-disable-next-line no-await-in-loop
        await walk(join(dirAbs, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(sandbox.root, join(dirAbs, entry.name)));
      }
    }
  }
  await walk(startAbs);
  return out;
}

// Runs `cmd` ONLY if it's present in `allowlist` (an array of exact command
// strings the TASK BUILDER wired up, e.g. ['npm', 'node'] — never arbitrary
// shell, and never a string the model supplies directly for `cmd` itself).
// This is the load-bearing safety boundary in place of a container: there is
// no path from "the model decided to run X" to X actually executing unless
// X is one of a small, task-defined set of known-safe commands.
export async function runSandboxCommand(sandbox, cmd, args = [], { cwd, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, allowlist } = {}) {
  if (!Array.isArray(allowlist) || !allowlist.includes(cmd)) {
    return { ok: false, output: `Command "${cmd}" is not in this task's allowlist (${(allowlist || []).join(', ')}) — refusing to run it.` };
  }
  const workDir = cwd ? resolveScopedPath(sandbox, cwd) : sandbox.root;
  // NODE_TEST_CONTEXT is how node:test's own runner talks to a test FILE
  // it spawned as a child process — inherited from this process's own env
  // when this handler itself runs under `node --test` (every unit test in
  // this repo), it leaks into a spawned `node --test <target>` command
  // here and makes THAT node:test run silently skip and report success
  // (see node's own test_runner internals: `NODE_TEST_CONTEXT === 'child'`
  // short-circuits to a no-op). Stripped unconditionally — this variable
  // has no meaning for anything this function ever runs (validation
  // commands, builds, installs), only for an actual nested test runner.
  const { NODE_TEST_CONTEXT, ...cleanEnv } = process.env;
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: workDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: cleanEnv,
    });
    return { ok: true, output: `${stdout}${stderr}`.slice(-4000) };
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr || ''}` || err.message;
    return { ok: false, output: String(output).slice(-4000) };
  }
}

// ── Snapshot / diff — the independent "what actually changed" check ────────
//
// Mirrors design_task.py's _snapshot_specific_files/_snapshot_code_files +
// _diff_snapshots: never trusts the agent's own claim of which files it
// touched. `relpaths` may be an explicit small list (capability-repair's
// 2-file allowlist) or every file discovered under a root dir
// (code-self-repair's whole-`server/`-tree scan, via listSandboxFiles).
export async function snapshotFiles(sandbox, relpaths) {
  const snapshot = {};
  for (const relpath of relpaths) {
    if (!relpath) continue;
    // eslint-disable-next-line no-await-in-loop
    snapshot[relpath] = await readSandboxFile(sandbox, relpath);
  }
  return snapshot;
}

// A small, dependency-free unified-diff line differ (classic LCS-based).
// Bounded to files under DIFF_LINE_LIMIT lines — an LCS table is O(n*m),
// and real source files this touches are always small; a file bigger than
// that gets a whole-file-replace hunk instead of a real line diff, which is
// still a valid, `patch`-applicable unified diff, just a blunter one.
const DIFF_LINE_LIMIT = 4000;

function unifiedDiff(path, oldText, newText) {
  const oldLines = (oldText ?? '').split('\n');
  const newLines = (newText ?? '').split('\n');
  if (oldLines.length > DIFF_LINE_LIMIT || newLines.length > DIFF_LINE_LIMIT) {
    return [
      `--- a/${path}`, `+++ b/${path}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`),
    ].join('\n');
  }
  // LCS table.
  const n = oldLines.length; const m = newLines.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { ops.push({ type: 'ctx', line: oldLines[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: 'del', line: oldLines[i] }); i++; }
    else { ops.push({ type: 'add', line: newLines[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', line: oldLines[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', line: newLines[j] }); j++; }

  const hunk = ops.map((op) => (op.type === 'ctx' ? ` ${op.line}` : op.type === 'del' ? `-${op.line}` : `+${op.line}`)).join('\n');
  const delCount = ops.filter((o) => o.type !== 'add').length;
  const addCount = ops.filter((o) => o.type !== 'del').length;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${delCount} +1,${addCount} @@`, hunk].join('\n');
}

// Real changed/added files only — never a deleted-file entry, matching
// design_task.py's own _diff_snapshots comment: deleting platform/tenant
// code is never the smallest safe automated fix. Returns
// [{path, newContent, patch}].
export function diffSnapshots(before, after) {
  const changed = [];
  for (const [relpath, newContent] of Object.entries(after)) {
    const oldContent = before[relpath];
    if (oldContent === newContent) continue;
    if (newContent == null) continue; // deleted — not reported
    changed.push({ path: relpath, newContent, patch: unifiedDiff(relpath, oldContent, newContent) });
  }
  return changed;
}
