// Pure helpers for the Claude Code worker (worker.mjs). No I/O here, so every rule that matters can be tested.

/**
 * The arguments for ONE request. The writer is deliberately a plain text writer:
 *   --tools ""                  no file, shell or web tools: it can only return text
 *   --no-session-persistence    nothing is saved to disk
 *   --setting-sources ""        none of the account's settings, hooks or instructions files are loaded
 *   --disable-slash-commands / --strict-mcp-config   no skills, no connectors
 * The system prompt goes in a file (it can be tens of kilobytes) and the user prompt on stdin.
 */
export function buildClaudeArgs({ systemFile, model = null }) {
  const args = [
    '-p', '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--system-prompt-file', systemFile,
  ];
  if (model) args.push('--model', model);
  return args;
}

// WHICH MODEL ANSWERS A REQUEST. Mechanical jobs (a 60-character meta title, a page-type label, a schema block, a pass/fail QA) do not need the strongest model, and
// each call costs about 10 seconds of Claude Code start-up either way: the light model is faster and uses far less of the plan. Everything else, blog posts and the
// analysis and narratives included, keeps WORKER_MODEL (Claude Code's default when unset). WORKER_LIGHT_MODEL=off turns this off; WORKER_LIGHT_GENERATORS replaces the list.
export const DEFAULT_LIGHT_GENERATORS = ['meta-title', 'page-content-classifier', 'gap-coverage', 'schema', 'qa-content', 'internal-links'];
export function modelForRequest(req, { model = null, lightModel = 'haiku', lightGenerators = DEFAULT_LIGHT_GENERATORS } = {}) {
  if (!lightModel || String(lightModel).toLowerCase() === 'off') return model;
  return req?.generatorId && lightGenerators.includes(req.generatorId) ? lightModel : model;
}

const LIMIT = /usage limit|limit reached|rate.?limit|too many requests|quota|overloaded|capacity|try again (later|in)|resets? (at|in)/i;
const AUTH = /not logged in|please (run )?\/?login|invalid api key|authentication|unauthori[sz]ed|credential/i;
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|timed out|timeout|5\d\d\b/i;

/**
 * What a failure means for the queue. A usage limit or an overloaded service is not the request's fault: it is given back and the worker rests (cooldownMs).
 * "Not logged in" is the person's to fix and stops the worker rather than failing request after request.
 */
export function classifyClaudeError(text) {
  const t = String(text || '');
  if (AUTH.test(t)) return { kind: 'auth', retryable: true, cooldownMs: 5 * 60_000, stop: true };
  if (LIMIT.test(t)) return { kind: 'limit', retryable: true, cooldownMs: 10 * 60_000 };
  if (TRANSIENT.test(t)) return { kind: 'transient', retryable: true, cooldownMs: 15_000 };
  return { kind: 'other', retryable: false, cooldownMs: 0 };
}

/** Reads what `claude -p --output-format json` printed. @returns {{ok:true, text:string, usage?:object} | {ok:false, error:string, retryable:boolean, cooldownMs:number, stop?:boolean, kind:string}} */
export function parseClaudeOutput({ stdout = '', stderr = '', code = 0, signal = null, timedOut = false } = {}) {
  if (timedOut) return { ok: false, error: 'claude took too long and was stopped', retryable: true, cooldownMs: 0, kind: 'timeout' };
  let j = null;
  try { j = JSON.parse(String(stdout).trim()); } catch { /* not JSON: handled below */ }
  if (j && j.is_error !== true && typeof j.result === 'string') {
    const text = j.result.trim();
    if (!text) return { ok: false, error: 'claude returned an empty answer', retryable: true, cooldownMs: 0, kind: 'empty' };
    return { ok: true, text, usage: j.usage ? { input: j.usage.input_tokens, output: j.usage.output_tokens } : undefined };
  }
  const reason = String(j?.result || j?.subtype || stderr || stdout || (signal ? `killed by ${signal}` : `claude exited ${code}`)).trim().slice(0, 400);
  return { ok: false, error: reason, ...classifyClaudeError(reason) };
}

/** Worker ids are 3-64 letters, digits, dots, dashes, underscores (the server refuses anything else). */
export function workerIdFrom(hostname, user = '') {
  const base = `${String(hostname || 'laptop').split('.')[0]}${user ? `-${user}` : ''}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  return base.length >= 3 ? base : `${base || 'worker'}-1`.padEnd(3, 'x');
}

/** Waiting time after a failed call to the server: 2s, 4s, 8s ... never more than a minute. */
/**
 * What the claim loop does with a failed call to the server. Only a refused token (401) stops the worker: that never fixes itself.
 * A 404 is what the server answers while it is being deployed or restarted (the route is simply not there yet), and it looks exactly like
 * "feature not enabled". 2026-11-25: one 404 seen mid-deploy made the worker exit, and no AI call was answered for the rest of the day.
 * So a 404 is retried for as long as it lasts; after SUSPECT_404_MS it is also reported as probably a wrong URL or token setting, but the
 * worker still keeps trying (a 60-second poll costs nothing, and a worker that has quit cannot notice the server coming back).
 * @returns {{action:'stop'|'retry', suspect?:boolean, reason?:string}}
 */
export const SUSPECT_404_MS = 30 * 60_000;
export function decideClaimFailure({ status = 0, firstNotFoundAt = null, now = Date.now() } = {}) {
  if (status === 401) return { action: 'stop', reason: 'the server refused the worker token' };
  if (status === 404) return { action: 'retry', suspect: firstNotFoundAt != null && now - firstNotFoundAt >= SUSPECT_404_MS, reason: 'route not found (server restarting, or a wrong SUPERRANK_URL / LLM_WORKER_TOKEN not set on the server)' };
  return { action: 'retry' };
}

/**
 * Hands a FINISHED answer (or a failure report) to the server, and keeps trying through a deploy or a network drop. Before this, one failed
 * hand-over (the server restarting at that moment) threw the written answer away: the request stayed "claimed" until the stale timer put it
 * back and the whole generation was paid for again. The text stays in memory and is retried with growing waits for up to `maxMs` (default
 * 10 minutes, longer than the server's 5-minute stale-claim window would make useful: after that the server has given the request to someone else).
 * Final at once (no retry): 400/401/403/409/410/413/422 — the server answered and means it ("not held by you any more", "too long", "bad token").
 * Retried: no answer at all, 404 (a deploy: the route is not there yet), 408, 429, and any 5xx.
 * @returns {Promise<{ok:true, value:any} | {ok:false, final:boolean, error:Error}>}
 */
export const FINAL_STATUSES = new Set([400, 401, 403, 409, 410, 413, 422]);
export async function deliverWithRetry(send, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxMs = 10 * 60_000, onRetry = () => {} } = {}) {
  const started = now(); let attempt = 0;
  for (;;) {
    try { return { ok: true, value: await send() }; }
    catch (error) {
      if (FINAL_STATUSES.has(error?.status)) return { ok: false, final: true, error };
      if (now() - started >= maxMs) return { ok: false, final: false, error };
      const ms = backoffMs(++attempt);
      onRetry({ error, attempt, ms });
      await sleep(ms);
    }
  }
}

export const backoffMs = (attempt) => Math.min(60_000, 2000 * 2 ** Math.max(0, attempt - 1));

export const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** One readable line per event, no prompt content. */
export function logLine(event, d = new Date()) {
  const at = clock(d);
  switch (event.type) {
    case 'start': return `${at}  worker ${event.workerId} started: ${event.concurrency} at a time, server ${event.server}`;
    case 'claimed': return `${at}  #${event.id} ${event.generatorId || 'ai call'} (site ${event.siteId ?? '-'}) picked up`;
    case 'done': return `${at}  #${event.id} done in ${secs(event.ms)} (${event.chars} characters)${event.tokens ? `, ${event.tokens} tokens` : ''}`;
    case 'failed': return `${at}  #${event.id} could not be written: ${event.error}${event.retryable ? ' (given back for another try)' : ''}`;
    case 'resting': return `${at}  resting ${Math.round(event.ms / 1000)}s: ${event.why}`;
    case 'server-error': return `${at}  cannot reach the server (${event.error}); trying again in ${Math.round(event.ms / 1000)}s`;
    case 'stats': return `${at}  so far: ${event.done} written, ${event.failed} failed, ${event.active} in progress`;
    case 'stop': return `${at}  stopping${event.held ? `, giving back ${event.held} unfinished` : ''}`;
    default: return `${at}  ${JSON.stringify(event)}`;
  }
}
