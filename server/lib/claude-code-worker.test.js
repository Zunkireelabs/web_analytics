import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, parseClaudeOutput, classifyClaudeError, workerIdFrom, backoffMs, logLine, clock, decideClaimFailure, SUSPECT_404_MS, deliverWithRetry, FINAL_STATUSES } from '../../tools/claude-code-worker/lib.mjs';

describe('the worker runs Claude Code as a plain text writer', () => {
  test('no tools, no saved sessions, none of the account\'s settings or instructions, no skills or connectors', () => {
    const a = buildClaudeArgs({ systemFile: '/tmp/s.txt' });
    const pair = (flag) => a[a.indexOf(flag) + 1];
    assert.equal(a[0], '-p');
    assert.equal(pair('--output-format'), 'json');
    assert.equal(pair('--tools'), '');
    assert.equal(pair('--setting-sources'), '');
    assert.equal(pair('--system-prompt-file'), '/tmp/s.txt');
    for (const f of ['--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config']) assert.ok(a.includes(f), f);
    assert.ok(!a.includes('--model'), 'no model forced unless asked');
    assert.equal(buildClaudeArgs({ systemFile: 'x', model: 'sonnet' }).at(-1), 'sonnet');
  });
});

describe('what Claude Code printed', () => {
  test('a normal answer', () => {
    const r = parseClaudeOutput({ stdout: JSON.stringify({ is_error: false, result: '  {"titles":["A"]}\n', usage: { input_tokens: 120, output_tokens: 30 } }) });
    assert.deepEqual(r, { ok: true, text: '{"titles":["A"]}', usage: { input: 120, output: 30 } });
  });
  test('an empty answer or output that is not JSON is a retryable failure, never an empty draft', () => {
    assert.equal(parseClaudeOutput({ stdout: JSON.stringify({ is_error: false, result: '  ' }) }).kind, 'empty');
    const bad = parseClaudeOutput({ stdout: 'garbage', stderr: 'boom', code: 1 });
    assert.equal(bad.ok, false); assert.equal(bad.error, 'boom');
  });
  test('an error Claude Code reports itself is read for what it means', () => {
    const limit = parseClaudeOutput({ stdout: JSON.stringify({ is_error: true, result: 'Claude usage limit reached. Your limit will reset at 3pm.' }) });
    assert.deepEqual([limit.ok, limit.kind, limit.retryable, limit.cooldownMs], [false, 'limit', true, 600_000]);
  });
  test('a timeout is retryable; a kill signal is described', () => {
    assert.deepEqual([parseClaudeOutput({ timedOut: true }).kind, parseClaudeOutput({ timedOut: true }).retryable], ['timeout', true]);
    assert.match(parseClaudeOutput({ signal: 'SIGKILL', code: null }).error, /killed by SIGKILL/);
  });
});

describe('what a failure means for the queue', () => {
  test('a usage limit or busy service is given back and the worker rests; it is never the request\'s fault', () => {
    for (const t of ['usage limit reached', 'rate limit exceeded', 'Overloaded', 'too many requests', 'quota exceeded']) assert.equal(classifyClaudeError(t).kind, 'limit', t);
  });
  test('not signed in stops the worker instead of failing every request', () => {
    for (const t of ['Not logged in · Please run /login', 'Invalid API key', 'authentication_error']) { const c = classifyClaudeError(t); assert.deepEqual([c.kind, c.stop], ['auth', true], t); }
  });
  test('a network blip is retried soon; anything else is final', () => {
    assert.equal(classifyClaudeError('fetch failed').kind, 'transient');
    assert.equal(classifyClaudeError('ECONNRESET').retryable, true);
    assert.deepEqual(classifyClaudeError('the model refused'), { kind: 'other', retryable: false, cooldownMs: 0 });
  });
});

describe('small rules', () => {
  test('worker ids are always ones the server accepts', () => {
    const ok = /^[A-Za-z0-9._-]{3,64}$/;
    for (const [h, u] of [['Yukta-MacBook.local', 'yukta'], ['', ''], ['a', ''], ['my laptop!', 'x y'], ['x'.repeat(200), 'u']]) assert.match(workerIdFrom(h, u), ok, `${h}|${u}`);
    assert.equal(workerIdFrom('Yukta-MacBook.local', 'yukta'), 'Yukta-MacBook-yukta');
  });
  test('retry waits grow to a minute and stop growing', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(backoffMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });
  test('one readable line per event, and never any prompt or page content', () => {
    const d = new Date(2026, 10, 24, 10, 42, 7);
    assert.equal(clock(d), '10:42:07');
    assert.equal(logLine({ type: 'claimed', id: 12, generatorId: 'meta-title', siteId: 1 }, d), '10:42:07  #12 meta-title (site 1) picked up');
    assert.equal(logLine({ type: 'done', id: 12, ms: 14200, chars: 480, tokens: 910 }, d), '10:42:07  #12 done in 14.2s (480 characters), 910 tokens');
    assert.match(logLine({ type: 'failed', id: 3, error: 'x', retryable: true }, d), /given back for another try/);
    assert.match(logLine({ type: 'resting', ms: 600000, why: 'busy' }, d), /resting 600s/);
    assert.match(logLine({ type: 'stop', held: 2 }, d), /giving back 2 unfinished/);
  });
});

describe('the worker survives a server deploy (2026-11-25: one 404 mid-deploy made it exit for the whole day)', () => {
  test('a 404 is retried, however long it lasts, and never stops the worker', () => {
    assert.deepEqual(decideClaimFailure({ status: 404, firstNotFoundAt: 1000, now: 1500 }).action, 'retry');
    const long = decideClaimFailure({ status: 404, firstNotFoundAt: 0, now: 3 * 60 * 60_000 });
    assert.equal(long.action, 'retry');
    assert.equal(long.suspect, true, 'after half an hour it is flagged as probably a settings problem, but still retried');
  });
  test('a short 404 (a deploy) is not flagged', () => {
    assert.equal(decideClaimFailure({ status: 404, firstNotFoundAt: 0, now: SUSPECT_404_MS - 1 }).suspect, false);
  });
  test('only a refused token stops it', () => {
    assert.equal(decideClaimFailure({ status: 401 }).action, 'stop');
    for (const status of [0, 429, 500, 502, 503, 504]) assert.equal(decideClaimFailure({ status }).action, 'retry', String(status));
  });
});

describe('a finished answer survives the server restarting at the moment it is handed over', () => {
  const noSleep = { sleep: async () => {} };
  const err = (status, message = 'x') => Object.assign(new Error(message), { status });
  test('retries through a connection drop, a 404 (route missing during a deploy) and 5xx, then delivers', async () => {
    const seen = []; let n = 0;
    const r = await deliverWithRetry(async () => { n++; if (n === 1) throw new Error('fetch failed'); if (n === 2) throw err(404); if (n === 3) throw err(502); return { ok: true }; }, { ...noSleep, onRetry: (x) => seen.push(x.attempt) });
    assert.deepEqual(r, { ok: true, value: { ok: true } }); assert.equal(n, 4); assert.deepEqual(seen, [1, 2, 3]);
  });
  test('a "you do not hold this any more" (409) or a refused token is final at once: no retry storm', async () => {
    for (const status of [409, 401, 400, 413]) { let n = 0; const r = await deliverWithRetry(async () => { n++; throw err(status); }, noSleep); assert.deepEqual([r.ok, r.final, n], [false, true, 1], String(status)); }
    assert.ok(FINAL_STATUSES.has(409));
  });
  test('gives up (not final) only after the time allowed, and reports the last error', async () => {
    let t = 0; let n = 0;
    const r = await deliverWithRetry(async () => { n++; throw err(503, 'down'); }, { sleep: async (ms) => { t += ms; }, now: () => t, maxMs: 60_000 });
    assert.equal(r.ok, false); assert.equal(r.final, false); assert.match(r.error.message, /down/); assert.ok(n >= 4);
  });
  test('waits grow as the worker\'s other retries do', async () => {
    const waits = []; let n = 0;
    await deliverWithRetry(async () => { if (++n < 5) throw err(500); return 1; }, { sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
  });
});

describe('modelForRequest: light model for mechanical jobs only', () => {
  test('meta titles and other mechanical jobs use the light model; blog posts, narratives and unknown jobs keep the default', async () => {
    const { modelForRequest } = await import('../../tools/claude-code-worker/lib.mjs');
    assert.equal(modelForRequest({ generatorId: 'meta-title' }, { model: null }), 'haiku');
    assert.equal(modelForRequest({ generatorId: 'blog-outline' }, { model: null }), null);
    assert.equal(modelForRequest({ generatorId: null }, { model: 'sonnet' }), 'sonnet');
    assert.equal(modelForRequest({ generatorId: 'meta-title' }, { model: 'sonnet', lightModel: 'off' }), 'sonnet');
    assert.equal(modelForRequest({ generatorId: 'faq' }, { model: null, lightGenerators: ['faq'] }), 'haiku');
  });
});
