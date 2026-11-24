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
