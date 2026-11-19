// One real AI-visibility probe, printed instead of saved. For checking web-search citation capture by hand:
//
//   OPENAI_API_KEY=... node server/scripts/probe-ai-citation-once.mjs --name SuperRank --domain superrank.si --prompt "..."
//
// Costs one OpenAI web search call plus a short extraction call (about 1-2 cents). Writes nothing anywhere: the
// database is never touched (DATABASE_URL is forced to an unreachable local address before anything loads).
process.env.DATABASE_URL = 'postgres://none:none@127.0.0.1:1/none';
process.env.AI_RECOMMENDATION_ENABLED = 'true';
process.env.AI_RECOMMENDATION_WEB_SEARCH = 'true';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const name = arg('name'); const domain = arg('domain'); const prompt = arg('prompt');
if (!name || !domain || !prompt || !process.env.OPENAI_API_KEY) {
  console.error('Usage: OPENAI_API_KEY=... node server/scripts/probe-ai-citation-once.mjs --name <company> --domain <domain> --prompt "<question>"');
  process.exit(1);
}

const openai = await import('../agents/lib/model-providers/openai.js');
const { detectMention, verifyExtractedCompetitors } = await import('../agents/ai-recommendation.js');

const probe = await openai.ask(prompt);
const mentioned = detectMention(probe.raw, name, domain);
const extracted = await openai.extract(probe.raw, { companyName: name, domain }).catch(() => null);

console.log('=== RAW ANSWER ===\n' + probe.raw);
console.log('\n=== MODEL ===', probe.model, probe.model.endsWith('+web-search') ? '' : '(web search did NOT run, memory-only fallback)');
console.log('=== SOURCES CONSULTED ===', probe.sourcesConsulted ?? 'n/a');
console.log('=== CITED DOMAINS ===', probe.citedDomains ?? null);
console.log('\n=== ROW THAT WOULD BE STORED (ai_prompt_runs, not inserted) ===');
console.log(JSON.stringify({
  provider: openai.id, model: probe.model, run_date: new Date().toISOString().slice(0, 10), mentioned,
  approximate_position: mentioned ? (extracted?.approximatePosition ?? null) : null,
  competitors_mentioned: verifyExtractedCompetitors(probe.raw, extracted?.competitorsMentioned),
  sentiment: extracted?.sentiment ?? null,
  recommendation_strength: mentioned ? (extracted?.recommendationStrength ?? null) : 'none',
  cited_domains: Array.isArray(probe.citedDomains) ? probe.citedDomains : null,
  raw_response: `${probe.raw.slice(0, 80)}… (${probe.raw.length} chars)`,
}, null, 2));
process.exit(0);
