// Keeps the REAL reason when an LLM call fails inside a generator.
//
// Every generator used to wrap callLLMForJson in a bare `catch {}` and throw
// "model did not return valid JSON" — whatever actually went wrong. On
// 2026-11-18 that hid a provider "429 You have no credits remaining" for ten
// days: every auto-fix failed with a message that blamed the model's output,
// the failures were scored against the generators, and nobody was told the
// account was simply out of credit.
//
// callLLMForJson's own unparseable-output failure is the one genuine "invalid
// JSON" case (message below, status 400). Anything else is the provider or
// the network, and must surface as such so the shipping loop can stop the run
// (failure-policy.js) instead of burning one call per remaining item.

const INVALID_JSON_PREFIX = 'Model did not return valid JSON';

const QUOTA_PATTERN = /no credits remaining|enforced spend limit|insufficient[_ ]quota|exceeded your current quota|billing|credit balance is too low|payment required/i;
const AUTH_PATTERN = /invalid[_ ]api[_ ]key|incorrect api key|authentication[_ ]error|unauthorized|x-api-key/i;

export function isInvalidJsonError(err) {
  return typeof err?.message === 'string' && err.message.startsWith(INVALID_JSON_PREFIX);
}

/**
 * @param err      what callLLMForJson threw
 * @param message  the generator's historical "...did not return valid JSON" text
 * @param extra    the extra properties that message always carried (status, userFacing)
 * @returns an Error to throw. A provider fault keeps the provider's own text and is
 *          tagged llmQuota / llmAuth / llmProvider; an output fault keeps the old shape.
 */
/** True when `err` is the AI provider or the network failing (out of credit, bad key, 5xx, timeout), not the model's own output. */
export function isProviderFault(err) {
  if (!err) return false;
  const text = typeof err.message === 'string' && err.message ? err.message : '';
  const providerStatus = err.status ?? err.response?.status ?? null;
  const networkCode = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(err.code);
  // Provider/network fault = a real HTTP status other than our own 400, a
  // network error code, or text that names quota/auth. A plain Error with no
  // status (a generator's own "not an array" check inside the same try) and
  // callLLMForJson's own 400 are output faults and keep the old message.
  return !isInvalidJsonError(err) && (
    networkCode
    || (Number.isInteger(providerStatus) && providerStatus !== 400)
    || QUOTA_PATTERN.test(text) || AUTH_PATTERN.test(text)
  );
}

export function llmFailure(err, message, extra = { status: 400 }) {
  const text = typeof err?.message === 'string' && err.message ? err.message : '';
  const providerStatus = err?.status ?? err?.response?.status ?? null;
  if (!isProviderFault(err)) {
    return Object.assign(new Error(message), extra);
  }
  const out = new Error(`LLM provider error: ${text || err.code || 'call failed'}`.slice(0, 400));
  // 502, not the provider's own 429: the shipping loop reads 429 as a GitHub
  // rate limit and would wait instead of stopping. The provider's status is
  // kept on llmStatus for logs. Never userFacing, never a refusal.
  out.status = 502;
  out.llmProvider = true;
  out.llmStatus = providerStatus;
  if (QUOTA_PATTERN.test(text) || providerStatus === 402) out.llmQuota = true;
  if (AUTH_PATTERN.test(text) || providerStatus === 401) out.llmAuth = true;
  return out;
}
