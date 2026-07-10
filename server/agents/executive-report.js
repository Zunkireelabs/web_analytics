import { getAgent } from './registry.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'executive-report',
  name: 'Executive Report Agent',
  description: 'Synthesizes every specialist agent into one growth summary.',
  category: 'meta',
  version: 2,
  requires: ['query-intelligence', 'opportunity', 'country-intelligence', 'device-intelligence', 'ai-visibility', 'content-gap'],
};

// Calls each sub-agent's run() directly (not runAgent()) so this doesn't write
// N redundant history rows per exec run, and collects their facts as-is — no
// re-fetching, no re-aggregation. One LLM call then synthesizes all sections
// (facts + each sub-agent's own narrative) into one executive summary.
//
// Sub-agents run concurrently, not sequentially — they're independent reads
// of the same site/date-range, so there's no reason to wait on one before
// starting the next. Each is wrapped in its own try/catch so one agent
// erroring doesn't fail the others or the whole report.
export async function run(input) {
  const entries = await Promise.all(meta.requires.map(async (id) => {
    const agent = await getAgent(id);
    if (!agent) return [id, { status: 'error', message: `agent "${id}" is not registered` }];
    try {
      const out = await agent.run(input);
      return [id, {
        status: out.status, facts: out.facts, narrative: out.narrative ?? null,
        message: out.message ?? null,
      }];
    } catch (err) {
      return [id, { status: 'error', message: String(err?.message || err) }];
    }
  }));
  const sections = Object.fromEntries(entries);

  const system = 'You are a growth strategist writing an executive summary for a non-technical site owner, ' +
    'synthesizing six specialist agents\' findings (query intelligence, opportunity, country intelligence, ' +
    'device intelligence, AI visibility, content gap) into one 4-6 sentence growth summary. Use ONLY the facts ' +
    'given, never invent numbers. Any section may have status "insufficient-data" or "error" instead of "ok" — ' +
    'if one does, name it plainly as a gap rather than omitting or guessing at it. A lower average Search ' +
    'position is BETTER. Plain text, no markdown, no bullets.';
  const user = `Sub-agent sections: ${JSON.stringify(sections)}`;
  const narrative = await callLLM(system, user, { maxTokens: 400 })
    .catch((err) => { console.warn('[agents] executive-report narrative failed:', err.message); return null; });

  return {
    meta,
    status: 'ok',
    facts: { rangeStart: input.start, rangeEnd: input.end, sections },
    narrative,
    generatedAt: new Date().toISOString(),
  };
}
