import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// Structural invariants for "a detection can actually reach a fix". These are
// the exact conditions that silently broke before: an agent listed as a
// recommendation source but not registered; a generator with no implementer
// so a draft could never become a file change; an agent pointing at a
// generator id that does not exist.
//
// Asserted here rather than trusted to review, because every one of them
// fails silently at runtime — a dropped finding looks identical to a healthy
// site with nothing to fix.

// Loading the agent registry imports every agent, and several of them reach
// the `openai` package (llm.js, agentic-orchestrator.js, the model-providers)
// whose own dependency formdata-node -> web-streams-polyfill fails to
// instantiate under the test runner. Stubbing the package itself covers every
// route to it at once, and deliberately keeps the REAL llm.js in the graph —
// a partial llm.js stub would hide the very breakage this test exists to
// catch, where a module imports a named helper that no longer exists.
mock.module('openai', { defaultExport: class OpenAIStub {} });

const { RECOMMENDATION_AGENT_IDS } = await import('./insights.js');
const { listGeneratorMeta } = await import('../../generators/registry.js');
const { getImplementerForGenerator } = await import('../../implementers/registry.js');
const { riskTierForGenerator } = await import('./risk-tiers.js');

// geo-audit is deliberately report/score-only: it produces a dashboard
// surface and a report body, never a file diff, and is explicitly excluded
// from buildRecommendations (see agents/lib/recommendations.js's header).
// Listed here so "has no implementer" stays a recorded decision rather than
// something a future reader has to rediscover — and so any OTHER generator
// losing its implementer fails this test loudly.
const DELIBERATELY_NO_IMPLEMENTER = new Set(['geo-audit']);

describe('agent -> generator -> implementer pipeline contract', () => {
  test('every recommendation-source agent is actually registered', async () => {
    const { getAgent } = await import('../registry.js');
    const missing = [];
    for (const id of RECOMMENDATION_AGENT_IDS) {
      if (!(await getAgent(id))) missing.push(id);
    }
    assert.deepEqual(missing, [], `listed as recommendation sources but not registered: ${missing.join(', ')}`);
  });

  test('every generator resolves to an implementer, or is a recorded report-only exception', async () => {
    const metas = await listGeneratorMeta();
    const orphaned = [];
    for (const m of metas) {
      if (DELIBERATELY_NO_IMPLEMENTER.has(m.id)) continue;
      if (!(await getImplementerForGenerator(m.id))) orphaned.push(m.id);
    }
    // An orphaned generator can be drafted but never applied — the draft
    // reaches approval and dies there, which reads to a user as the system
    // silently ignoring an approved fix.
    assert.deepEqual(orphaned, [], `generators with no implementer: ${orphaned.join(', ')}`);
  });

  test('every generator has a resolvable risk tier', async () => {
    const metas = await listGeneratorMeta();
    for (const m of metas) {
      const tier = riskTierForGenerator(m.id);
      assert.ok(tier === 'safe' || tier === 'manual', `${m.id} resolved to an unexpected tier: ${tier}`);
    }
  });

  test('generator ids referenced by agent routing all exist', async () => {
    const metas = await listGeneratorMeta();
    const known = new Set(metas.map((m) => m.id));
    // The routing tables agents actually use to pick a generator. A typo or a
    // renamed generator here produces a recommendation nothing can ever draft.
    const { GAP_TYPE_TO_GENERATOR, TAG_TO_GENERATOR } = await import('./page-content.js');
    const referenced = [
      ...Object.values(GAP_TYPE_TO_GENERATOR || {}),
      ...Object.values(TAG_TO_GENERATOR || {}),
      // Routed directly from an agent rather than through a table.
      'blog-outline',
    ].filter(Boolean);

    const unknown = [...new Set(referenced)].filter((id) => !known.has(id));
    assert.deepEqual(unknown, [], `agents route to generator ids that do not exist: ${unknown.join(', ')}`);
  });
});
