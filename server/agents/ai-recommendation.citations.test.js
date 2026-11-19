import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// End to end for one run of the AI recommendation agent, with only the three outside edges replaced: the Postgres
// driver (so every real store function and its real SQL runs, but nothing connects anywhere), the OpenAI SDK and the
// DataForSEO HTTP client (recorded answers instead of paid calls). Everything between them is the real code: provider
// selection, web search request, citation parsing, mention check, competitor check, one row per engine, and the
// INSERT into ai_prompt_runs with cited_domains. Written because a provider can parse citations perfectly and still
// lose them on the way to the database, which is exactly what happened before 2026-11-18 (cited_domains always null).

process.env.DATABASE_URL = 'postgres://none:none@127.0.0.1:1/none'; // set before db.js loads dotenv, so .env never wins
for (const k of ['AI_RECOMMENDATION_ANTHROPIC_ENABLED', 'AI_RECOMMENDATION_PERPLEXITY_ENABLED', 'AI_RECOMMENDATION_WEB_SEARCH_TOOL']) delete process.env[k];
Object.assign(process.env, {
  AI_RECOMMENDATION_ENABLED: 'true', OPENAI_API_KEY: 'test-key', AI_RECOMMENDATION_WEB_SEARCH: 'true',
  DATAFORSEO_LOGIN: 'u', DATAFORSEO_PASSWORD: 'p', AI_CITATION_TRACKING_ENABLED: 'true', AI_CITATION_ENGINES: 'chatgpt,google_ai_overview',
});

const resolve = (p) => new URL(p, import.meta.url).href;
const site = { id: 8871, name: 'SuperRank', website_domain: 'superrank.si', status: 'active' };
const prompt = { id: 501, site_id: 8871, prompt_text: 'What are the best tools to track mentions of my website in ChatGPT answers?', source: 'query', active: true };

// ── Postgres driver: answers by SQL, records every ai_prompt_runs insert ──
const inserts = [];
class FakePool {
  on() {}
  async query(text, params = []) {
    const sql = String(text);
    if (/FROM sites WHERE id = \$1/.test(sql)) return { rows: [site] };
    if (/FROM ai_tracked_prompts WHERE site_id = \$1 AND active = true/.test(sql)) return { rows: [prompt] };
    if (/INSERT INTO ai_prompt_runs/.test(sql)) {
      inserts.push({ sql, params });
      return { rows: [{ id: inserts.length, site_id: params[0], prompt_id: params[1], provider: params[2], model: params[3], mentioned: params[6], cited_domains: params[11] }] };
    }
    return { rows: [] };
  }
}
mock.module('pg', { defaultExport: { Pool: FakePool } });

// ── OpenAI SDK: a recorded web-search answer in the documented Responses API shape ──
const openaiCalls = [];
const webSearchResponse = {
  output_text: 'Popular options include SuperRank, Ahrefs Brand Radar and Semrush AI Toolkit.',
  output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'track website mentions in ChatGPT', sources: [
      { type: 'url', url: 'https://www.superrank.si/' }, { type: 'url', url: 'https://ahrefs.com/brand-radar' },
      { type: 'url', url: 'https://www.semrush.com/kb/ai-toolkit' }, { type: 'url', url: 'https://zapier.com/blog/ai-visibility-tools' },
    ] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Popular options include SuperRank, Ahrefs Brand Radar and Semrush AI Toolkit.', annotations: [
      { type: 'url_citation', start_index: 24, end_index: 33, url: 'https://www.superrank.si/?utm_source=openai', title: 'SuperRank' },
      { type: 'url_citation', start_index: 35, end_index: 53, url: 'https://ahrefs.com/brand-radar?utm_source=openai', title: 'Brand Radar' },
      { type: 'url_citation', start_index: 58, end_index: 77, url: 'https://zapier.com/blog/ai-visibility-tools?utm_source=openai', title: 'Zapier' },
    ] }] },
  ],
};
class FakeOpenAI {
  constructor() {
    this.responses = { create: async (args) => { openaiCalls.push({ api: 'responses', args }); return webSearchResponse; } };
    this.chat = { completions: { create: async (args) => {
      openaiCalls.push({ api: 'chat', args });
      // The extraction pass. "Moz" is a name the model invents: the agent must drop it (not in the answer text).
      return { choices: [{ message: { content: JSON.stringify({ approximatePosition: 1, competitorsMentioned: ['Ahrefs', 'Semrush', 'Moz'], sentiment: 'positive', recommendationStrength: 'moderate' }) } }] };
    } } };
  }
}
mock.module('openai', { defaultExport: FakeOpenAI });

// ── DataForSEO: one recorded answer per engine ──
const dfsCalls = [];
mock.module(resolve('../providers/dataforseo/client.js'), {
  namedExports: {
    dataforseoCall: async (args) => {
      dfsCalls.push(args);
      const items = args.endpoint.includes('chat_gpt')
        ? [{ type: 'chat_gpt_text', sections: [{ text: 'Try Semrush or SuperRank.', links: [{ url: 'https://www.semrush.com/' }, { url: 'https://superrank.si/pricing' }] }] }]
        : [{ type: 'ai_overview', items: [{ text: 'Tools like Ahrefs track AI mentions.', references: [{ url: 'https://ahrefs.com/blog/ai-overviews' }] }] }];
      return { ok: true, costUsd: 0.004, body: { tasks: [{ result: [{ items }] }] } };
    },
  },
});

// Not under test and would otherwise fetch the live homepage / call an LLM for prompt ideas and the narrative.
mock.module(resolve('./lib/page-content.js'), { namedExports: { analyzePageUrl: async () => ({ ok: false }), effortForGenerator: () => 'Medium' } });
mock.module(resolve('../llm.js'), { namedExports: { callLLM: async () => '[]' } });

const { run } = await import('./ai-recommendation.js');

test('one run stores real cited domains: OpenAI web search plus every DataForSEO engine', async () => {
  const out = await run({ siteId: 8871, start: '2026-10-19', end: '2026-11-17' });
  assert.notEqual(out.status, 'insufficient-data', out.message);

  // The request uses the current tool and asks for the full source list.
  const ws = openaiCalls.find((c) => c.api === 'responses');
  assert.deepEqual(ws.args.tools, [{ type: 'web_search' }]);
  assert.deepEqual(ws.args.include, ['web_search_call.action.sources']);

  // DataForSEO was asked once per enabled engine (before: only the first engine, ever).
  assert.deepEqual(dfsCalls.map((c) => c.endpoint).sort(), ['/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced', '/v3/serp/google/organic/live/advanced']);

  const rows = inserts.map(({ params }) => ({
    provider: params[2], model: params[3], mentioned: params[6],
    competitors: JSON.parse(params[8]), cited: params[11] == null ? null : JSON.parse(params[11]),
  }));
  console.log('rows that would be stored:\n' + rows.map((r) => '  ' + JSON.stringify(r)).join('\n'));
  assert.equal(rows.length, 3);

  const openaiRow = rows.find((r) => r.provider === 'openai');
  assert.equal(openaiRow.model, 'gpt-4o-mini+web-search');
  assert.deepEqual(openaiRow.cited, ['superrank.si', 'ahrefs.com', 'zapier.com']);
  assert.equal(openaiRow.mentioned, true);
  assert.deepEqual(openaiRow.competitors, ['Ahrefs', 'Semrush']); // the invented "Moz" never reaches the database

  const chatgpt = rows.find((r) => r.model === 'chatgpt');
  assert.deepEqual(chatgpt.cited, ['semrush.com', 'superrank.si']);
  assert.equal(chatgpt.mentioned, true);

  const overview = rows.find((r) => r.model === 'google-ai-overview');
  assert.deepEqual(overview.cited, ['ahrefs.com']);
  assert.equal(overview.mentioned, false); // cited a rival, not us: a real "not mentioned"

  // The INSERT really names the column (the bug was a correct parse that never reached SQL).
  assert.match(inserts[0].sql, /cited_domains/);
});
