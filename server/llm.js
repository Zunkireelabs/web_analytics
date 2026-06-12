import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Shared LLM helper used by both the daily narrative and the weekly doc report.
// Provider is chosen automatically: a real OPENAI_API_KEY → OpenAI, else Anthropic.
// Force with REPORT_PROVIDER=openai|anthropic.
function pickProvider() {
  if (process.env.REPORT_PROVIDER) return process.env.REPORT_PROVIDER.toLowerCase();
  const oa = process.env.OPENAI_API_KEY;
  if (oa && !oa.startsWith('sk-xxxx')) return 'openai';
  return 'anthropic';
}

// Calls the chosen LLM with a system + user prompt and returns plain text.
// `model` overrides the default for that provider (e.g. the monthly model).
export async function callLLM(system, user, { model, maxTokens = 500 } = {}) {
  const provider = pickProvider();
  if (provider === 'openai') {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await openai.chat.completions.create({
      model: model || process.env.REPORT_MODEL_DAILY || 'gpt-4o-mini',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    return res.choices[0]?.message?.content?.trim() || '';
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: model || process.env.REPORT_MODEL_DAILY || 'claude-haiku-4-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}
