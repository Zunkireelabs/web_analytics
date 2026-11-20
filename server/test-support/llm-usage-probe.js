import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Test helper: records the REAL token usage of every model call made while a test runs, by wrapping the SDK clients' create methods.
// Only used by opt-in integration tests (nothing in production imports this). Usage is the provider's own count from each response.
const totals = { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
let installed = false;

function note(model, input, output) {
  totals.calls += 1; totals.inputTokens += input || 0; totals.outputTokens += output || 0;
  const m = (totals.byModel[model] ||= { calls: 0, inputTokens: 0, outputTokens: 0 });
  m.calls += 1; m.inputTokens += input || 0; m.outputTokens += output || 0;
}

export function installUsageProbe() {
  if (installed) return;
  installed = true;
  const anthropicMessages = Object.getPrototypeOf(new Anthropic({ apiKey: 'probe' }).messages);
  const origA = anthropicMessages.create;
  anthropicMessages.create = async function (req, ...rest) {
    const res = await origA.call(this, req, ...rest);
    note(req?.model || 'anthropic', res?.usage?.input_tokens, res?.usage?.output_tokens);
    return res;
  };
  const completions = Object.getPrototypeOf(new OpenAI({ apiKey: 'probe' }).chat.completions);
  const origO = completions.create;
  completions.create = async function (req, ...rest) {
    const res = await origO.call(this, req, ...rest);
    note(req?.model || 'openai', res?.usage?.prompt_tokens, res?.usage?.completion_tokens);
    return res;
  };
}

export const usageSnapshot = () => JSON.parse(JSON.stringify(totals));
export function usageSince(before) {
  const now = usageSnapshot();
  return { calls: now.calls - before.calls, inputTokens: now.inputTokens - before.inputTokens, outputTokens: now.outputTokens - before.outputTokens };
}
