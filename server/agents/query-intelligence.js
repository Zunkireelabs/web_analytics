import { getGscBreakdownRange, getTopMovers } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
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

  // This agent's first-ever structured findings: real query drops past a
  // real (non-zero) threshold. No draft generator fits "investigate why a
  // query dropped" — recommendedAction stays honestly null, same pattern as
  // device-intelligence, rather than forcing an ungrounded action.
  // `movers.droppers` is already sorted biggest-drop-first.
  const dropperPriorities = priorityByRank(movers.droppers);
  const findings = movers.droppers.map((d, i) => makeFinding({
    id: `query-intelligence:dropper:${d.query}`,
    evidence: { query: d.query, recent: d.recent, prior: d.prior, delta: d.delta },
    whyItMatters: `"${d.query}" clicks dropped from ${d.prior} to ${d.recent} (${start} to ${end} vs the prior period).`,
    priority: dropperPriorities[i],
    recommendedAction: null,
    expectedImpact: { label: impactFromPriority(dropperPriorities[i]), basis: 'computed', value: Math.abs(d.delta) },
  }));

  const facts = {
    rangeStart: start,
    rangeEnd: end,
    priorStart: prior.start,
    priorEnd: prior.end,
    topQueries,
    gainers: movers.gainers,
    droppers: movers.droppers,
    findings,
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
