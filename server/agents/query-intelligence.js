import { getGscBreakdownRange, getTopMovers } from '../store/read.js';
import { priorPeriod } from '../util/dates.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'query-intelligence',
  name: 'Query Intelligence Agent',
  description: 'Surfaces the search queries driving (or dragging) organic performance.',
  category: 'seo',
  version: 2,
};

export async function run({ siteId, start, end }) {
  const prior = priorPeriod(start, end);
  const [topQueries, movers] = await Promise.all([
    getGscBreakdownRange(siteId, start, end, 'query', 10),
    getTopMovers(siteId, { start, end }, prior, 8),
  ]);

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    priorStart: prior.start,
    priorEnd: prior.end,
    topQueries,
    gainers: movers.gainers,
    droppers: movers.droppers,
  };

  const system = 'You are an SEO analyst summarizing search query movement for a non-technical site owner. ' +
    'Given top queries plus gainers/droppers (the requested period vs an equal-length prior period), write ' +
    '2-3 sentences highlighting the most notable gains and drops. Use ONLY the numbers given, never compute ' +
    'your own percentages. Plain text, no markdown, no bullets.';
  const user = `Facts: ${JSON.stringify(facts)}`;
  const narrative = await callLLM(system, user, { maxTokens: 250 })
    .catch((err) => { console.warn('[agents] query-intelligence narrative failed:', err.message); return null; });

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
