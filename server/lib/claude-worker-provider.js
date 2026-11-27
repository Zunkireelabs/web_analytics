import { enqueueRequest, waitForRequest, workerOnline } from '../store/llm-requests.js';

// ROUTING AI CALLS TO THE CLAUDE CODE WORKER.
//
// A fix generator (meta-title, expand-content, qa-content, faq, blog-outline, ...) asks callLLM for text. With LLM_WORKER_MODE=on that call is put in the queue
// (store/llm-requests.js) and answered by Claude Code running on a person's laptop, instead of by a paid AI API. Everything else is unchanged: the server's
// quality and design checks, the repo write and the pull request.
//
// A call that names a generator MUST go to the worker. Agents' own analysis, narration and synthesis (no generatorId) go to the worker too (2026-11-27: they no longer fall back to the paid API when no worker is connected,
// unless LLM_WORKER_FALLBACK=api). AI-visibility probes (they must ask the
// real provider) and image calls never come here.
//
// Off unless LLM_WORKER_MODE=on, so deploying this changes nothing by itself. When on and no worker is connected:
//   LLM_WORKER_FALLBACK=none (default)  the call fails as "the AI provider is unavailable", which the platform already treats as an outage: it is retried
//                                       later, never counted against the generator, never closes an issue
//   LLM_WORKER_FALLBACK=api             the call goes to the API provider exactly as it did before

export const workerMode = (env = process.env) => String(env.LLM_WORKER_MODE || '').toLowerCase() === 'on';
export const workerFallback = (env = process.env) => (String(env.LLM_WORKER_FALLBACK || '').toLowerCase() === 'api' ? 'api' : 'none');
export const workerWaitMs = (env = process.env) => Math.max(30_000, Number(env.LLM_WORKER_WAIT_MS) || 10 * 60_000);

/** An error the rest of the platform reads as "the AI provider was unavailable" (generators/lib/llm-error.js isProviderFault: a status other than 400). */
export function workerUnavailable(message, extra = {}) {
  return Object.assign(new Error(message), { status: 502, llmProvider: true, workerUnavailable: true, ...extra });
}

/**
 * Decides where one call goes. Pure apart from the worker-online check, which is injected.
 * @returns {Promise<'worker' | 'api'>}  or throws workerUnavailable when it must go to the worker and none is connected
 */
export async function routeCall({ generatorId } = {}, { env = process.env, online = workerOnline } = {}) {
  if (!workerMode(env)) return 'api';
  // Analysis/narration/synthesis (no generatorId) follow the same rule as a fix: ALL AI goes through the worker. With the laptop closed the call does not fall back to a paid API
  // (owner's rule, 2026-11-27): it fails as "provider unavailable", is retried when the worker is back, and never closes an issue. LLM_WORKER_FALLBACK=api restores the old fall-back.
  if (await online()) return 'worker';
  if (workerFallback(env) === 'api') return 'api';
  throw workerUnavailable('The Claude Code worker is not connected, so no fix can be written right now. It runs when the laptop is open; this is retried on the next pass.', { workerOffline: true });
}

/** Sends the call through the queue and waits for the worker's text. */
export async function callViaWorker({ system, user, generatorId = null, siteId = null, maxTokens = null, tier = 'daily', pageUrl = null }, { env = process.env, enqueue = enqueueRequest, wait = waitForRequest } = {}) {
  const timeoutMs = workerWaitMs(env);
  const id = await enqueue({ siteId, generatorId, system, user, options: { maxTokens, tier, pageUrl }, ttlMs: timeoutMs });
  const r = await wait(id, { timeoutMs });
  if (r.ok) return r.text;
  throw workerUnavailable(
    r.reason === 'expired'
      ? 'The Claude Code worker did not answer in time (the laptop may have closed or gone to sleep). This is retried on the next pass.'
      : `The Claude Code worker could not write this: ${r.error}`,
    { requestId: id, workerReason: r.reason },
  );
}
