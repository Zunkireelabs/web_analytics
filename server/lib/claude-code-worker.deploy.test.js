// THE REAL WORKER PROCESS against a fake server that behaves the way a deploy does: the claim route answers 404 while the app restarts, then the
// server drops a connection at the exact moment the finished answer is handed over. The worker must stay alive, must not lose the answer, and must
// give back what a previous run was holding when it starts. `claude` is a stub script; nothing leaves this machine (127.0.0.1 only).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKER = resolve(import.meta.dirname, '../../tools/claude-code-worker/worker.mjs');

function fakeServer(script) {
  const log = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = req.url.replace('/api/worker', '');
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch { /* none */ }
      const n = log.filter((l) => l.path === path).length + 1;
      log.push({ path, n, body, at: Date.now() });
      const r = script(path, n, body, req, res);
      if (r === 'drop') return req.socket.destroy();
      const { status = 200, json = {} } = r || {};
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, log, url: `http://127.0.0.1:${server.address().port}` })));
}

function startWorker(url) {
  const dir = mkdtempSync(join(tmpdir(), 'srw-deploy-test-'));
  const claude = join(dir, 'claude-stub.sh');
  writeFileSync(claude, '#!/bin/sh\ncat >/dev/null\nprintf \'{"is_error":false,"result":"the written answer","usage":{"input_tokens":3,"output_tokens":4}}\'\n');
  chmodSync(claude, 0o755);
  const child = spawn(process.execPath, [WORKER], {
    env: { PATH: process.env.PATH, SUPERRANK_URL: url, LLM_WORKER_TOKEN: 'test-token', CLAUDE_BIN: claude, WORKER_CONCURRENCY: '1', WORKER_ID: 'deploy-test-1', WORKER_CLAUDE_CONFIG_DIR: 'default', HOME: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = []; child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return { child, out, exited };
}
const until = async (fn, ms = 40_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

describe('the real worker process through a server deploy', () => {
  test('claim answers 404 while the app restarts, then the answer is handed over through two dropped/failed attempts: worker alive, answer delivered once, startup release called', async () => {
    let handedOver = null;
    const { server, log, url } = await fakeServer((path, n, body) => {
      if (path === '/release') return { json: { released: 2 } };
      if (path === '/claim') {
        if (n <= 2) return { status: 404, json: { error: 'Not found' } };              // deploy: route not there yet
        if (n === 3) return { json: { requests: [{ id: 41, siteId: 1, generatorId: 'blog-outline', system: 's', user: 'u', options: {} }] } };
        return { json: { requests: [] } };
      }
      if (path === '/requests/41/complete') {
        if (n === 1) return 'drop';                                                      // the server restarts exactly now
        if (n === 2) return { status: 502, json: { error: 'bad gateway' } };
        handedOver = body.text; return { json: { ok: true } };
      }
      return { json: {} };
    });
    const w = startWorker(url);
    try {
      const done = await until(() => handedOver !== null, 60_000);
      assert.ok(done, `the answer was never delivered. worker output:\n${w.out.join('')}`);
      assert.equal(handedOver, 'the written answer');
      assert.equal(log.filter((l) => l.path === '/requests/41/complete').length, 3, 'two failed hand-overs then one success');
      assert.equal(w.child.exitCode, null, 'the worker is still running after the 404s and the failed hand-overs');
      assert.ok(log.some((l) => l.path === '/release'), 'the worker gave back what a previous run was holding when it started');
      assert.ok(log.findIndex((l) => l.path === '/release') < log.findIndex((l) => l.path === '/claim'), 'and did so before claiming anything new');
    } finally { w.child.kill('SIGTERM'); await Promise.race([w.exited, new Promise((r) => setTimeout(r, 3000))]); w.child.kill('SIGKILL'); server.close(); }
  });

  test('a refused token (401) stops the worker with a clear message; it does not retry forever', async () => {
    const { server, url } = await fakeServer((path) => (path === '/release' ? { json: { released: 0 } } : { status: 401, json: { error: 'bad token' } }));
    const w = startWorker(url);
    try {
      const code = await Promise.race([w.exited, new Promise((r) => setTimeout(() => r('still-running'), 30_000))]);
      assert.equal(code, 3, `expected exit code 3; output:\n${w.out.join('')}`);
      assert.match(w.out.join(''), /refused the worker \(401\)/);
    } finally { w.child.kill('SIGKILL'); server.close(); }
  });
});
