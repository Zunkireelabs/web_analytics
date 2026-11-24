import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const { makeHandlers, requireWorkerToken } = await import('./claude-worker.js');

// An in-memory stand-in for the queue table, with the same rules the SQL has: only a holder can answer, a retryable failure goes back, a release gives back.
function memoryStore() {
  const rows = []; const workers = new Map(); let seq = 0;
  return {
    rows,
    enqueue(r) { rows.push({ id: ++seq, status: 'pending', attempts: 0, ...r }); return seq; },
    async heartbeat(id) { workers.set(id, Date.now()); },
    async sweep() {},
    async claimRequests(w, limit) { const take = rows.filter((r) => r.status === 'pending').slice(0, limit); take.forEach((r) => { r.status = 'claimed'; r.worker = w; r.attempts++; }); return take.map((r) => ({ id: r.id, siteId: r.siteId, generatorId: r.generatorId, system: r.system, user: r.user, options: {} })); },
    async completeRequest(id, w, text) { const r = rows.find((x) => x.id === id); if (!r || r.worker !== w || r.status !== 'claimed') return { ok: false }; r.status = 'done'; r.text = text; return { ok: true }; },
    async failRequest(id, w, error, { retryable }) { const r = rows.find((x) => x.id === id); if (!r || r.worker !== w || r.status !== 'claimed') return { ok: false }; r.error = error; r.status = retryable && r.attempts < 3 ? 'pending' : 'failed'; r.worker = null; return { ok: true }; },
    async releaseRequests(w, ids) { let n = 0; rows.filter((r) => r.worker === w && r.status === 'claimed' && (!ids || ids.includes(r.id))).forEach((r) => { r.status = 'pending'; r.worker = null; r.attempts--; n++; }); return { released: n }; },
    async queueStatus() { return { requests: {}, workersOnline: workers.size }; },
  };
}

const TOKEN = 'e2e-token';
let server; let base; let dir; let store; let fakeClaude; let argsLog;

before(async () => {
  store = memoryStore();
  const app = express(); app.use(express.json());
  const h = makeHandlers({ store, env: { LLM_WORKER_MODE: 'on' } });
  app.use('/api/worker', (req, res, next) => requireWorkerToken(req, res, next, { LLM_WORKER_TOKEN: TOKEN }));
  app.post('/api/worker/heartbeat', h.heartbeat); app.post('/api/worker/claim', h.claim);
  app.post('/api/worker/requests/:id/complete', h.complete); app.post('/api/worker/requests/:id/fail', h.fail); app.post('/api/worker/release', h.release);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // A stand-in for `claude -p ... --output-format json`: records how it was called, answers like Claude Code does.
  dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  argsLog = join(dir, 'calls.jsonl');
  fakeClaude = join(dir, 'claude');
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('fs');
let input = ''; process.stdin.on('data', (d) => input += d).on('end', () => {
  const a = process.argv.slice(2);
  const sys = fs.readFileSync(a[a.indexOf('--system-prompt-file') + 1], 'utf8');
  fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify({ args: a, cwdFiles: fs.readdirSync(process.cwd()), configDir: process.env.CLAUDE_CONFIG_DIR, sys, input }) + '\\n');
  if (input.includes('PLEASE-HIT-LIMIT')) { console.log(JSON.stringify({ is_error: true, result: 'Claude usage limit reached. Your limit will reset at 3pm.' })); return; }
  console.log(JSON.stringify({ is_error: false, result: '{"echo":"' + input.slice(0, 20) + '"}', usage: { input_tokens: 50, output_tokens: 8 } }));
});
`);
  chmodSync(fakeClaude, 0o755);
});
after(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
function startWorker(extraEnv = {}) {
  const worker = fileURLToPath(new URL('../../tools/claude-code-worker/worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [worker], { env: { ...process.env, SUPERRANK_URL: base, LLM_WORKER_TOKEN: TOKEN, CLAUDE_BIN: fakeClaude, WORKER_CONCURRENCY: '1', WORKER_CLAUDE_CONFIG_DIR: join(dir, 'profile'), WORKER_ID: 'e2e-laptop', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  return { child, output: () => out };
}

describe('the real worker program against the real endpoint code', () => {
  test('claims a request, writes it with the isolated Claude Code call, and the server gets the text; then it stops cleanly', async () => {
    const id = store.enqueue({ siteId: 8862, generatorId: 'meta-title', system: 'SYSTEM PROMPT TEXT', user: 'USER PROMPT TEXT' });
    const { child, output } = startWorker();
    assert.ok(await waitFor(() => store.rows.find((r) => r.id === id)?.status === 'done'), `not answered. worker said:\n${output()}`);
    assert.equal(store.rows.find((r) => r.id === id).text, '{"echo":"USER PROMPT TEXT"}');

    const call = JSON.parse(readFileSync(argsLog, 'utf8').trim().split('\n')[0]);
    assert.equal(call.sys, 'SYSTEM PROMPT TEXT', 'the system prompt reached claude through a file');
    assert.equal(call.input, 'USER PROMPT TEXT', 'the user prompt reached claude on stdin');
    assert.deepEqual(call.cwdFiles.filter((f) => f !== 'system.txt'), [], 'it ran in an empty directory');
    assert.equal(call.configDir, join(dir, 'profile'), 'it used its own isolated profile, not the person\'s');
    for (const f of ['--tools', '--no-session-persistence', '--setting-sources', '--disable-slash-commands', '--strict-mcp-config']) assert.ok(call.args.includes(f), f);

    assert.match(output(), /picked up/); assert.match(output(), /done in [\d.]+s \(\d+ characters\)/);
    assert.ok(!/USER PROMPT TEXT|SYSTEM PROMPT TEXT/.test(output()), 'no prompt content in the log');
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGINT');
    assert.equal(await exited, 0);
  });

  test('a Claude usage limit gives the request back (not failed, not lost) and the worker rests instead of hammering it', async () => {
    const id = store.enqueue({ siteId: 1, generatorId: 'faq', system: 'S', user: 'PLEASE-HIT-LIMIT' });
    const { child, output } = startWorker();
    assert.ok(await waitFor(() => /resting/.test(output())), `no rest. worker said:\n${output()}`);
    const row = store.rows.find((r) => r.id === id);
    assert.equal(row.status, 'pending', 'given back for another try');
    assert.match(row.error, /usage limit/i);
    assert.equal(row.attempts, 1, 'it was tried once, then the worker rested rather than retrying at once');
    const exited = new Promise((r) => child.on('exit', (c) => r(c)));
    child.kill('SIGINT'); await exited;
  });

  test('a wrong token stops the worker with a clear message instead of retrying forever', async () => {
    const { child, output } = startWorker({ LLM_WORKER_TOKEN: 'wrong' });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 3, 'a non-zero exit, so a launcher can see it failed');
    assert.match(output(), /refused the worker \(401\)/);
  });

  test('without a server address or token it explains what to set', async () => {
    const worker = fileURLToPath(new URL('../../tools/claude-code-worker/worker.mjs', import.meta.url));
    const child = spawn(process.execPath, [worker], { env: { PATH: process.env.PATH, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 2); assert.match(out, /SUPERRANK_URL/);
  });
});
