#!/usr/bin/env node
// The Claude Code worker. Runs on a laptop; connects OUT to the SuperRank server, takes AI writing requests, writes the text with Claude Code and sends it back.
// It never sees a repository, GitHub or the database: a prompt in, text out. The server does everything else. See README.md.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname, homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs, parseClaudeOutput, workerIdFrom, backoffMs, logLine } from './lib.mjs';

const env = process.env;
const SERVER = String(env.SUPERRANK_URL || '').replace(/\/+$/, '');
const CONCURRENCY = Math.max(1, Math.min(Number(env.WORKER_CONCURRENCY) || 2, 4));
const TIMEOUT_MS = Math.max(30_000, Number(env.WORKER_TIMEOUT_MS) || 4 * 60_000);
const CLAUDE_BIN = env.CLAUDE_BIN || 'claude';
// WORKER_CLAUDE_CONFIG_DIR=default runs Claude Code exactly as the person normally uses it (their own login, nothing set). Setting CLAUDE_CONFIG_DIR, even to
// ~/.claude, makes Claude Code look for the login under a different keychain entry, so it would ask for a second sign-in.
const USE_DEFAULT_PROFILE = env.WORKER_CLAUDE_CONFIG_DIR === 'default';
const CONFIG_DIR = USE_DEFAULT_PROFILE ? null : (env.WORKER_CLAUDE_CONFIG_DIR || join(homedir(), '.superrank-worker', 'claude'));
const MODEL = env.WORKER_MODEL || null;
const WORKER_ID = env.WORKER_ID || workerIdFrom(hostname(), userInfo().username);
const VERSION = '1';

function readToken() {
  if (env.LLM_WORKER_TOKEN) return env.LLM_WORKER_TOKEN;
  if (process.platform === 'darwin') {
    try { return execFileSync('security', ['find-generic-password', '-s', 'superrank-worker', '-w'], { encoding: 'utf8' }).trim(); } catch { /* not stored */ }
  }
  return '';
}
const TOKEN = readToken();
if (!SERVER || !TOKEN) {
  console.error('Set SUPERRANK_URL and the worker token (LLM_WORKER_TOKEN, or in the macOS keychain: security add-generic-password -s superrank-worker -a worker -w <token>).');
  process.exit(2);
}

const say = (e) => console.log(logLine(e));
const stats = { done: 0, failed: 0, active: 0 };
let stopping = false; let restUntil = 0; let serverFailures = 0;
const held = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body, { timeoutMs = 40_000, method = 'POST' } = {}) {
  const res = await fetch(`${SERVER}/api/worker${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify({ workerId: WORKER_ID, ...body }), signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  return json;
}

/** Runs Claude Code on one request: system prompt in a file, user prompt on stdin, answer from its JSON output. */
function runClaude({ system, user }) {
  const dir = mkdtempSync(join(tmpdir(), 'srw-'));   // an empty directory: nothing to read, nothing to leak
  const systemFile = join(dir, 'system.txt');
  writeFileSync(systemFile, system);
  if (CONFIG_DIR) mkdirSync(CONFIG_DIR, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, buildClaudeArgs({ systemFile, model: MODEL }), { cwd: dir, env: CONFIG_DIR ? { ...env, CLAUDE_CONFIG_DIR: CONFIG_DIR } : (({ CLAUDE_CONFIG_DIR: _drop, ...rest }) => rest)(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); resolve(parseClaudeOutput({ stderr: `spawn failed: ${e.message}`, code: 1 })); });
    child.on('close', (code, signal) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); resolve(parseClaudeOutput({ stdout, stderr, code, signal, timedOut })); });
    child.stdin.end(user);
  });
}

async function handle(req) {
  const started = Date.now();
  say({ type: 'claimed', id: req.id, generatorId: req.generatorId, siteId: req.siteId });
  stats.active++; held.add(req.id);
  try {
    const out = await runClaude({ system: req.system, user: req.user });
    if (out.ok) {
      await api(`/requests/${req.id}/complete`, { text: out.text });
      stats.done++;
      say({ type: 'done', id: req.id, ms: Date.now() - started, chars: out.text.length, tokens: out.usage ? (out.usage.input || 0) + (out.usage.output || 0) : null });
    } else {
      await api(`/requests/${req.id}/fail`, { error: out.error, retryable: out.retryable });
      stats.failed++;
      say({ type: 'failed', id: req.id, error: out.error, retryable: out.retryable });
      if (out.cooldownMs) { restUntil = Date.now() + out.cooldownMs; say({ type: 'resting', ms: out.cooldownMs, why: out.kind === 'limit' ? 'the Claude usage limit or service is busy' : out.kind }); }
      if (out.stop) { stopping = true; process.exitCode = 4; console.error('\nClaude Code is not signed in for the worker profile. Run:\n  ' + (CONFIG_DIR ? 'CLAUDE_CONFIG_DIR="' + CONFIG_DIR + '" ' : '') + 'claude\nthen /login, and start the worker again.'); }
    }
  } catch (e) {
    say({ type: 'failed', id: req.id, error: `could not report the result: ${e.message}`, retryable: true });
  } finally { stats.active--; held.delete(req.id); }
}

async function lane() {
  let attempt = 0;
  while (!stopping) {
    if (Date.now() < restUntil) { await sleep(Math.min(5000, restUntil - Date.now())); continue; }
    try {
      const { requests } = await api('/claim', { limit: 1, waitMs: 20_000, info: { host: hostname(), version: VERSION } }, { timeoutMs: 45_000 });
      attempt = 0; serverFailures = 0;
      for (const r of requests) await handle(r);
    } catch (e) {
      if (e.status === 401 || e.status === 404) { console.error(`The server refused the worker (${e.status}): ${e.message}. Check SUPERRANK_URL and the token, and that LLM_WORKER_TOKEN is set on the server.`); process.exitCode = 3; stopping = true; return; }
      const ms = backoffMs(++attempt); say({ type: 'server-error', error: e.message, ms }); await sleep(ms);
    }
  }
}

async function shutdown() {
  if (stopping && !held.size) return;
  stopping = true; say({ type: 'stop', held: held.size });
  const until = Date.now() + 60_000;
  while (held.size && Date.now() < until) await sleep(500);
  if (held.size) await api('/release', { ids: [...held] }, { timeoutMs: 10_000 }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

say({ type: 'start', workerId: WORKER_ID, concurrency: CONCURRENCY, server: SERVER });
setInterval(() => say({ type: 'stats', ...stats }), 5 * 60_000).unref();
await Promise.all(Array.from({ length: CONCURRENCY }, lane));
