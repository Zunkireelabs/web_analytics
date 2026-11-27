// ALL AI THROUGH THE CLAUDE WORKER (owner's rule, 2026-11-27). The only things allowed to call a paid AI API directly are the AI-visibility probes (they must ask the
// real ChatGPT / Claude / Google AI) and the client chat assistant. Anything else that would call one directly (the agentic question loop, the design self-repair loop,
// screenshot checks) asks this first. No imports on purpose: callers load it without touching the database layer.
//
// With LLM_WORKER_MODE=on the paid API is refused, unless LLM_WORKER_FALLBACK=api is set (the old behaviour). With the mode off nothing changes.
export const paidApiAllowed = (env = process.env) =>
  String(env.LLM_WORKER_MODE || '').toLowerCase() !== 'on' || String(env.LLM_WORKER_FALLBACK || '').toLowerCase() === 'api';

/** An error the platform reads as "the AI provider was unavailable" (a status other than 400): retried later, never counted against the work. */
export function paidApiRefused(what) {
  return Object.assign(new Error(`${what} needs a tool-using model and the Claude worker takes plain text only, so it is paused: no paid AI API is used.`), { status: 502, llmProvider: true, workerUnavailable: true });
}
