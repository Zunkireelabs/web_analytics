import { activeModelFor } from './lib/model-override.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { withAgentMemory } from './agent-memory.js';
import { withDesignContext } from './implementers/lib/design-drift.js';
import { withCompetitorContext } from './agents/lib/competitor-policy.js';

// Shared LLM helper used by both the daily narrative and the weekly doc report.
// Provider is chosen automatically: a real OPENAI_API_KEY → OpenAI, else Anthropic.
// Force with REPORT_PROVIDER=openai|anthropic.
export function pickProvider() {
  if (process.env.REPORT_PROVIDER) return process.env.REPORT_PROVIDER.toLowerCase();
  const oa = process.env.OPENAI_API_KEY;
  if (oa && !oa.startsWith('sk-xxxx')) return 'openai';
  return 'anthropic';
}

// Split work between providers. A call tagged `task: 'report'` (client reports and narratives) or `task: 'content'` (the
// text the agent writes onto a client's site: generators, FAQ/schema/meta, design layout) can run on its own provider via
// LLM_PROVIDER_REPORTS / LLM_PROVIDER_CONTENT, with its own models via LLM_MODEL_<TASK>_DAILY / _MONTHLY. Untagged calls,
// and tagged calls whose variable is unset, behave exactly as before (REPORT_PROVIDER + REPORT_MODEL_*).
const TASK_ENV = { report: 'REPORTS', content: 'CONTENT' };
const PROVIDER_KEY = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const warnedTasks = new Set();

export function resolveProviderAndModel({ task, tier = 'daily', model, promoted, env = process.env } = {}) {
  const base = env.REPORT_PROVIDER ? env.REPORT_PROVIDER.toLowerCase()
    : (env.OPENAI_API_KEY && !env.OPENAI_API_KEY.startsWith('sk-xxxx') ? 'openai' : 'anthropic');
  const name = TASK_ENV[task];
  let provider = base;
  const wanted = name && env[`LLM_PROVIDER_${name}`] ? env[`LLM_PROVIDER_${name}`].toLowerCase() : null;
  if (wanted && wanted !== base) {
    // A task switched to a provider whose key is missing would fail every call; stay on the working default instead.
    if (PROVIDER_KEY[wanted] && env[PROVIDER_KEY[wanted]]) provider = wanted;
    else if (!warnedTasks.has(task)) {
      warnedTasks.add(task);
      console.warn(`[llm] LLM_PROVIDER_${name}=${wanted} but ${PROVIDER_KEY[wanted] || 'its key'} is not set — using ${base} for ${task} calls.`);
    }
  }
  const t = tier === 'monthly' ? 'monthly' : 'daily';
  const resolvedModel = model
    || (promoted && promoted.provider === provider ? promoted.model : null)
    || (name ? env[`LLM_MODEL_${name}_${t.toUpperCase()}`] : null)
    // REPORT_MODEL_* names a model of the default provider; never send it to the other one.
    || (provider === base ? env[t === 'monthly' ? 'REPORT_MODEL_MONTHLY' : 'REPORT_MODEL_DAILY'] : null)
    || MODEL_DEFAULTS[provider][t];
  return { provider, model: resolvedModel };
}

// Transient upstream failures (rate limits, 5xx, dropped connections) are
// worth one retry — a bare `throw` on the first hiccup is what turned into a
// raw 500 for a user clicking a generator button during the product audit.
// Non-retryable errors (bad request, auth, etc.) fail immediately.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

// Both SDKs default to a multi-minute timeout, so a connection that stalls
// without erroring (rather than cleanly failing) can hold a caller open for
// a very long time — e.g. Run Full Analysis awaiting ~19 parallel agents,
// several of which make LLM calls. Exported so agentic-orchestrator.js's
// own `new OpenAI(...)` client gets the same ceiling.
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// OpenAI quota fallback.
//
// When the OpenAI project's spend limit (or credit) is exhausted every call fails with a 429 whose code is insufficient_quota /
// project_spend_limit_exceeded. That is not a rate limit that clears in a second: the whole project is blocked until someone raises
// the limit. Before this, every agent and generator then failed ("model did not return valid JSON", "took too long to compute").
//
// Now a quota failure (a) is not retried, (b) is answered by the same call on Anthropic, if ANTHROPIC_API_KEY is set, and (c) opens a
// breaker so the next calls go straight to Anthropic for LLM_QUOTA_COOLDOWN_MS (default 15 min). When the cooldown ends ONE call
// probes OpenAI again; if it works the breaker resets and everything is back on OpenAI by itself, if it is still blocked the cooldown
// restarts. Set LLM_FALLBACK_ON_QUOTA=off to disable. Without an Anthropic key behaviour is exactly what it was.
// ---------------------------------------------------------------------------------------------------------------------------------
const QUOTA_CODE_RE = /insufficient_quota|project_spend_limit_exceeded|billing_hard_limit_reached/i;
const QUOTA_TEXT_RE = /enforced spend limit|exceeded your current quota|insufficient[_ ]quota|no credits remaining|billing/i;
export function isQuotaExhaustedError(err) {
  if (!err) return false;
  const status = err.status ?? err.response?.status;
  if (status != null && status !== 429 && status !== 402) return false;
  const code = err.code ?? err.error?.code ?? err.error?.type ?? '';
  return QUOTA_CODE_RE.test(String(code)) || QUOTA_TEXT_RE.test(String(err.message || ''));
}

const quotaBreaker = { blockedUntil: 0 };
const PROBE_LEASE_MS = 60_000; // while one call probes OpenAI, every other call keeps using the fallback
const quotaCooldownMs = () => Number(process.env.LLM_QUOTA_COOLDOWN_MS) || 15 * 60_000;
export function fallbackAvailable(env = process.env) {
  return String(env.LLM_FALLBACK_ON_QUOTA || '').toLowerCase() !== 'off' && Boolean(env.ANTHROPIC_API_KEY);
}
// 'openai' = call OpenAI normally; 'probe' = the cooldown just ended, this call tests OpenAI; 'fallback' = go to Anthropic.
export function openAiRoute(now = Date.now(), env = process.env) {
  if (!fallbackAvailable(env) || quotaBreaker.blockedUntil === 0) return 'openai';
  if (now < quotaBreaker.blockedUntil) return 'fallback';
  quotaBreaker.blockedUntil = now + PROBE_LEASE_MS;
  return 'probe';
}
export function noteOpenAiQuotaExhausted(err, now = Date.now()) {
  const wasClosed = quotaBreaker.blockedUntil === 0;
  quotaBreaker.blockedUntil = now + quotaCooldownMs();
  if (wasClosed) console.warn(`[llm] OpenAI quota exhausted (${String(err?.message || err).slice(0, 140)}) — routing LLM calls to Anthropic; OpenAI is re-tested every ${Math.round(quotaCooldownMs() / 60000)} min and used again as soon as it works.`);
}
export function noteOpenAiHealthy() {
  if (quotaBreaker.blockedUntil !== 0) { quotaBreaker.blockedUntil = 0; console.log('[llm] OpenAI is working again — back on OpenAI.'); }
}
export function llmFallbackState() { return { blockedUntil: quotaBreaker.blockedUntil, active: quotaBreaker.blockedUntil !== 0 }; }
export function _resetQuotaBreakerForTest() { quotaBreaker.blockedUntil = 0; }

export function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  // A spent quota is not a transient hiccup: retrying it three times only burns the call timeout and, with 27 agents running at once,
  // is what turned an exhausted OpenAI project into agents that "took too long to compute".
  if (isQuotaExhaustedError(err)) return false;
  if (status === 429 || status >= 500) return true;
  if (!status && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code)) return true;
  return false;
}

// Exported so other direct OpenAI/Anthropic callers (e.g. agentic-orchestrator.js's
// tool-calling loop) get the same one-retry-on-transient-failure behavior as callLLM,
// instead of reimplementing it.
export async function withRetry(fn) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[llm] attempt ${attempt} failed (${err.message}), retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// `REPORT_MODEL_MONTHLY` has always been documented in .env.example for
// "the monthly model" (a stronger tier for infrequent, higher-stakes calls)
// but was never actually read anywhere — every call silently used the cheap
// daily-tier model. `tier: 'monthly'` completes that: for calls where model
// world-knowledge matters more than per-call cost (e.g. weekly competitor
// discovery, where a cheap model reliably misses real, niche local
// companies), pass tier: 'monthly' to use the stronger default.
export const MODEL_DEFAULTS = {
  openai: { daily: 'gpt-4o-mini', monthly: 'gpt-4o' },
  anthropic: { daily: 'claude-haiku-4-5', monthly: 'claude-opus-4-8' },
};

// Calls the chosen LLM with a system + user prompt and returns plain text.
// `model` overrides the resolved default outright; `tier` picks which
// REPORT_MODEL_* env var / built-in default to fall back to otherwise.
// `generatorId` (+ optional `siteId`) opts into the shared agent_fix_memory
// prompt injection (server/agent-memory.js's withAgentMemory) — pass the
// calling generator's own meta.id. This is the automatic RETRIEVE step of
// the platform-wide learning loop: every generator gets it for free just by
// passing its own id, with no separate opt-in per generator.
export async function callLLM(system, user, { model, maxTokens = 500, tier = 'daily', generatorId, siteId, pageUrl, modelRole, task } = {}) {
  system = await withAgentMemory(system, generatorId, siteId);
  // Shared design-intelligence layer (server/implementers/lib/design-drift.js) —
  // real site design/voice grounding for every website-facing generator, the
  // same automatic-by-generatorId shape as withAgentMemory just above. A
  // no-op for generatorIds outside DESIGN_CONTEXT_GENERATOR_IDS (purely
  // technical output) and for any site without a usable Design Context yet.
  system = await withDesignContext(system, generatorId, siteId, { pageUrl });
  // Tenant-scoped competitor-domain policy — same automatic-by-generatorId
  // shape as the two above, a no-op outside COMPETITOR_CONTEXT_GENERATOR_IDS
  // or when this site has no active competitor data. See
  // agents/lib/competitor-policy.js.
  system = await withCompetitorContext(system, generatorId, siteId);
  // A model promoted through the evaluated registry for this call's ROLE (only decision-engine calls pass one; a model tuned to
  // decide is never used to write page content). Used only when it belongs to the provider in use and no model was forced.
  const promoted = !model && modelRole ? await activeModelFor(modelRole) : null;
  const { provider, model: resolvedModel } = resolveProviderAndModel({ task, tier, model, promoted });

  if (provider === 'openai') {
    const route = openAiRoute();
    if (route === 'fallback') return callAnthropicText(system, user, { model: fallbackModel(tier), maxTokens: fallbackMaxTokens(maxTokens), fallback: true });
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS });
      const res = await withRetry(() => openai.chat.completions.create({
        model: resolvedModel,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }));
      noteOpenAiHealthy();
      recordLlmUsage({ provider: 'openai', model: resolvedModel, usage: res.usage });
      return res.choices[0]?.message?.content?.trim() || '';
    } catch (err) {
      if (fallbackAvailable() && isQuotaExhaustedError(err)) {
        noteOpenAiQuotaExhausted(err);
        return callAnthropicText(system, user, { model: fallbackModel(tier), maxTokens: fallbackMaxTokens(maxTokens), fallback: true });
      }
      throw err;
    }
  }

  return callAnthropicText(system, user, { model: resolvedModel, maxTokens });
}

// The Anthropic text call, shared by the normal Anthropic path and the OpenAI-quota fallback above.
// `fallback` marks the quota-fallback path: only that path may continue a cut-off reply (see runAnthropic).
function callAnthropicText(system, user, { model, maxTokens, fallback = false }) {
  return runAnthropic(system, [{ role: 'user', content: user }], { model, maxTokens, fallback });
}

// An OpenAI model name (or REPORT_MODEL_*) must never be sent to Anthropic: the fallback always uses Anthropic's own tier default.
const fallbackModel = (tier) => MODEL_DEFAULTS.anthropic[tier === 'monthly' ? 'monthly' : 'daily'];

// Callers size maxTokens for OpenAI's tokenizer. Claude spends more tokens on the same text (much more for Nepali,
// Hindi and other non-Latin scripts), so a fallback call with the same budget was cut off mid-JSON: verified
// 2026-11-20, translation stopped at 1500/1500 tokens and failed as "invalid JSON", and a 2500-token blog outline was still cut
// off at 5000. The fallback gives 4x the budget (capped). A bigger ceiling costs nothing unless the reply actually uses it.
// 4x is the most Claude MAY use, not a target: it is only ever a max_tokens ceiling, and a short reply stops early and is billed for
// what it used. Only the Claude fallback gets it; OpenAI calls keep the caller's own maxTokens.
export const FALLBACK_TOKEN_FACTOR = 4;
export const FALLBACK_HARD_CAP = 16000;
export function fallbackMaxTokens(maxTokens) {
  return Math.min(Math.max(Number(maxTokens) || 500, 1) * FALLBACK_TOKEN_FACTOR, FALLBACK_HARD_CAP);
}

function warnIfTruncated(msg, model, maxTokens) {
  if (msg?.stop_reason === 'max_tokens') console.warn(`[llm] ${model} reply was cut off at max_tokens=${maxTokens}; the output is incomplete.`);
}

// callLLM, but for a prompt that also needs to show the model real images —
// added for visual-quality.js (server/agents/visual-quality.js), the first
// caller in this codebase that needs multi-modal content. Deliberately a
// SEPARATE function rather than a `images` option bolted onto callLLM: every
// existing callLLM caller stays byte-for-byte unaffected, and this function
// stays free to diverge (e.g. no JSON-retry loop — see below) without that
// affecting text-only callers.
//
// `images` is an array of base64-encoded JPEG strings, kept in memory by the
// caller only (this codebase writes nothing to disk/DB for them — see
// capture.js's own screenshot option) and attached as real image content
// blocks, not described in text. No JSON-retry-on-bad-shape loop like
// callLLMForJson has: a vision call is already the most expensive kind this
// codebase makes, so a caller here is expected to defensively re-parse with
// extractJson() itself and treat a parse failure as "zero findings this
// run" rather than pay for a second full vision round-trip.
export async function callLLMWithImages(system, user, images, { model, maxTokens = 1500, tier = 'daily', generatorId, siteId, task } = {}) {
  system = await withAgentMemory(system, generatorId, siteId);
  system = await withDesignContext(system, generatorId, siteId);
  const { provider, model: resolvedModel } = resolveProviderAndModel({ task, tier, model });
  const imageList = Array.isArray(images) ? images : [];

  const anthropicContent = () => [
    { type: 'text', text: user },
    ...imageList.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
  ];
  if (provider === 'openai') {
    if (openAiRoute() === 'fallback') return callAnthropicBlocks(system, anthropicContent(), { model: fallbackModel(tier), maxTokens: fallbackMaxTokens(maxTokens), fallback: true });
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS });
      const content = [
        { type: 'text', text: user },
        ...imageList.map((data) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })),
      ];
      const res = await withRetry(() => openai.chat.completions.create({
        model: resolvedModel,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }));
      noteOpenAiHealthy();
      recordLlmUsage({ provider: 'openai', model: resolvedModel, usage: res.usage });
      return res.choices[0]?.message?.content?.trim() || '';
    } catch (err) {
      if (fallbackAvailable() && isQuotaExhaustedError(err)) {
        noteOpenAiQuotaExhausted(err);
        return callAnthropicBlocks(system, anthropicContent(), { model: fallbackModel(tier), maxTokens: fallbackMaxTokens(maxTokens), fallback: true });
      }
      throw err;
    }
  }

  return callAnthropicBlocks(system, anthropicContent(), { model: resolvedModel, maxTokens });
}

function callAnthropicBlocks(system, content, { model, maxTokens, fallback = false }) {
  return runAnthropic(system, [{ role: 'user', content }], { model, maxTokens, fallback });
}

// One Anthropic request, with usage recorded. On the fallback path only, a reply cut off at max_tokens is continued ONCE
// (the partial reply is sent back and Claude is asked to carry on) instead of the whole task being rerun. The continuation
// can never push total output past FALLBACK_HARD_CAP, so the ceiling stays a ceiling: it is never a target and never unbounded.
export async function runAnthropic(system, messages, { model, maxTokens, fallback, client }) {
  const anthropic = client || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS });
  const send = (msgs, max) => withRetry(() => anthropic.messages.create({ model, max_tokens: max, system, messages: msgs }));
  const textOf = (m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

  let msg = await send(messages, maxTokens);
  recordLlmUsage({ provider: 'anthropic', model, usage: msg?.usage, fallback });
  let text = textOf(msg);

  if (fallback && msg?.stop_reason === 'max_tokens') {
    const room = FALLBACK_HARD_CAP - (msg?.usage?.output_tokens || maxTokens);
    if (room > 0) {
      const next = await send([...messages, { role: 'assistant', content: text }, { role: 'user', content: 'Your reply was cut off. Continue exactly where you stopped, with no preamble and no repetition.' }], room);
      recordLlmUsage({ provider: 'anthropic', model, usage: next?.usage, fallback, continuation: true });
      text += textOf(next);
      msg = next;
    }
  }
  warnIfTruncated(msg, model, fallback ? FALLBACK_HARD_CAP : maxTokens);
  return text.trim();
}

// Actual tokens and estimated cost per provider/model, kept for the life of the process and logged per call, so a bigger
// fallback ceiling can be checked against what was really spent. Prices are USD per million tokens; they are estimates
// (override with LLM_PRICE_<MODEL>_IN / _OUT), and an unknown model is counted in tokens with cost null, never guessed.
const PRICE_PER_MTOK = {
  'gpt-4o-mini': [0.15, 0.6], 'gpt-4o': [2.5, 10],
  'claude-haiku-4-5': [1, 5], 'claude-opus-4-8': [5, 25],
};
const usageTotals = new Map();
export function llmCostUsd(model, inputTokens, outputTokens, env = process.env) {
  const key = String(model).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const inP = Number(env[`LLM_PRICE_${key}_IN`]) || PRICE_PER_MTOK[model]?.[0];
  const outP = Number(env[`LLM_PRICE_${key}_OUT`]) || PRICE_PER_MTOK[model]?.[1];
  if (inP == null || outP == null) return null;
  return (inputTokens * inP + outputTokens * outP) / 1e6;
}
export function recordLlmUsage({ provider, model, usage, fallback = false, continuation = false }) {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cost = llmCostUsd(model, inputTokens, outputTokens);
  const k = `${provider}|${model}|${fallback ? 'fallback' : 'primary'}`;
  const t = usageTotals.get(k) || { provider, model, fallback, calls: 0, continuations: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true };
  t.calls += 1; if (continuation) t.continuations += 1;
  t.inputTokens += inputTokens; t.outputTokens += outputTokens;
  if (cost == null) t.costKnown = false; else t.costUsd += cost;
  usageTotals.set(k, t);
  console.log(`[llm-usage] ${provider}/${model}${fallback ? ' (fallback)' : ''}${continuation ? ' (continuation)' : ''} in=${inputTokens} out=${outputTokens} cost=${cost == null ? 'unknown' : '$' + cost.toFixed(5)}`);
}
export const llmUsageTotals = () => [...usageTotals.values()];
export const _resetLlmUsageForTest = () => usageTotals.clear();

// Strips a markdown code fence wrapper (```json ... ``` or ``` ... ```) if
// present — models frequently wrap JSON in one despite an explicit
// "respond with ONLY JSON" instruction.
function stripCodeFence(raw) {
  return raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
}

// Best-effort JSON extraction: a direct parse first, then (if the model
// added stray prose before/after the JSON despite instructions not to) the
// widest {...}/[...] substring in the response. Returns null, never throws
// — callers decide what "still no valid JSON" means for them.
export function extractJson(raw) {
  const stripped = stripCodeFence(raw || '');
  try { return JSON.parse(stripped); } catch { /* fall through to substring extraction */ }
  const firstBrace = stripped.search(/[{[]/);
  const lastBrace = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'));
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  try { return JSON.parse(stripped.slice(firstBrace, lastBrace + 1)); } catch { return null; }
}

// callLLM, but for a JSON-shaped response — a distinct failure mode from
// the transient network/5xx retry callLLM already does internally: the
// HTTP call succeeds, but the model's actual text content isn't parseable
// JSON (stray prose, truncation, or just missing the mark despite an
// explicit "respond with ONLY JSON" instruction). Confirmed as a real,
// recurring failure across multiple generators (schema/faq/expand-content/
// meta-title/...), not a one-off — one retry with a sharper, explicit
// correction appended to the prompt before giving up honestly.
//
// `validate` (optional) extends the same one-retry treatment to a parsed
// response with the wrong *shape* (e.g. an object where an array was
// required) — without it, a caller that parses fine but fails a shape check
// downstream never gets the corrective-nudge retry at all, only the raw
// "not valid JSON" one. Defaults to accept-anything so existing callers are
// unaffected.
export async function callLLMForJson(system, user, options = {}) {
  const { validate = () => true, ...llmOptions } = options;
  const raw = await callLLM(system, user, llmOptions);
  const parsed = extractJson(raw);
  if (parsed !== null && validate(parsed)) return parsed;

  console.warn('[llm] first response was not valid JSON (or failed shape validation), retrying once with a corrective nudge…');
  const retryUser = `${user}\n\nYour previous response was not valid JSON. Respond with ONLY the raw JSON — no markdown code fences, no explanation, no text before or after it.`;
  const retryRaw = await callLLM(system, retryUser, llmOptions);
  const retryParsed = extractJson(retryRaw);
  if (retryParsed !== null && validate(retryParsed)) return retryParsed;

  throw Object.assign(new Error('Model did not return valid JSON after 2 attempts.'), { status: 400 });
}
