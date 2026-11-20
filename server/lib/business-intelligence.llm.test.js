import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// REAL integration test: live websites + a real Claude model. Opt-in, so `npm test` never spends money or needs the network:
//   RUN_LLM_INTEGRATION=1 node --test server/lib/business-intelligence.llm.test.js
// It uses the six real projects' public websites and no database. To avoid repeated paid calls, each model response is cached on disk by a
// hash of the exact evidence (LLM_TEST_CACHE_DIR); delete the cache to force a fresh call. Real token usage is recorded per project.
const ENABLED = process.env.RUN_LLM_INTEGRATION === '1';

const SITES = [
  { id: 1, name: 'Zunkiree Labs', domain: 'zunkireelabs.com' },
  { id: 8862, name: 'Admizz Education', domain: 'admizzeducation.com' },
  { id: 8864, name: 'Chayceproperties', domain: 'chayceproperties.com' },
  { id: 8871, name: 'Superrank', domain: 'superrank.si' },
  { id: 8872, name: 'Zennly', domain: 'zennly.io' },
  { id: 8874, name: 'MOBILISE', domain: 'mobilise.agency' },
];

describe('business intelligence engine, live sites + real Claude', { skip: !ENABLED && 'set RUN_LLM_INTEGRATION=1 to run (uses the network and the Anthropic API)' }, () => {
  const results = {};
  let refresh; let probe; let usageStart;

  before(async () => {
    await import('dotenv/config');
    // Pin Claude for this test. REPORT_MODEL_* in a developer's .env usually names OpenAI models, which Anthropic rejects as unknown.
    process.env.REPORT_PROVIDER = 'anthropic';
    process.env.REPORT_MODEL_DAILY = process.env.LLM_TEST_MODEL || 'claude-haiku-4-5';
    process.env.REPORT_MODEL_MONTHLY = process.env.LLM_TEST_MODEL || 'claude-haiku-4-5';
    probe = await import('../test-support/llm-usage-probe.js');
    probe.installUsageProbe();
    ({ refreshBusinessProfile: refresh } = await import('./business-intelligence.js'));
    usageStart = probe.usageSnapshot();
  });

  const cacheDir = process.env.LLM_TEST_CACHE_DIR;
  const cachedLlm = (real) => async (system, user, opts) => {
    if (!cacheDir) return real(system, user, opts);
    mkdirSync(cacheDir, { recursive: true });
    const file = join(cacheDir, `${createHash('sha256').update(system + user).digest('hex').slice(0, 24)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    const out = await real(system, user, opts);
    writeFileSync(file, JSON.stringify(out));
    return out;
  };

  for (const s of SITES) {
    test(`${s.name}: runs end to end and records a version with evidence`, async () => {
      const { callLLMForJson } = await import('../llm.js');
      const saved = [];
      const t0 = probe.usageSnapshot();
      const out = await refresh(s.id, {
        reason: 'baseline',
        deps: {
          getSite: async () => ({ id: s.id, website_domain: s.domain }),
          inventoryPaths: async () => [], topQueries: async () => [], capabilities: async () => [], onboarding: async () => null,
          llm: cachedLlm(callLLMForJson),
          getCurrent: async () => null,
          save: async (id, body) => { saved.push({ id, body }); return { unchanged: false, version: 1 }; },
        },
      });
      const used = probe.usageSince(t0);
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.insufficient, false, `insufficient: ${out.reason}`);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].id, s.id);
      const p = saved[0].body.profile;
      results[s.name] = { p, used, state: out.state };
      assert.ok(p.fields.ownIndustry.value, 'own industry found');
      assert.ok(p.fields.ownIndustry.evidence.length > 0 && p.fields.ownIndustry.evidence.every((e) => e.quote), 'own industry is backed by quoted evidence');
      assert.ok(p.fields.productsServices.value?.length > 0, 'products and services found');
      assert.ok(p.fields.targetCustomers.value?.length > 0, 'target customers found');
      assert.ok(['detected', 'unverified', 'partially-confirmed'].includes(out.state));
    });
  }

  const label = (n) => results[n]?.p.fields.ownIndustry.value?.label || '';
  const join_ = (n, k) => JSON.stringify(results[n]?.p.fields[k].value || '');

  test('Zennly: software sold to salons, NOT a wellness or salon business', () => {
    assert.match(label('Zennly'), /software|saas/i);
    assert.doesNotMatch(label('Zennly'), /wellness|fitness|salon|spa\b|beauty/i);
    assert.match(join_('Zennly', 'targetCustomerIndustries'), /salon|spa/i);
    assert.equal(results.Zennly.p.fields.businessModel.value?.model, 'saas');
  });

  test('Superrank: AI search and organic growth software, not generic technology', () => {
    assert.doesNotMatch(label('Superrank'), /^\s*technology\s*$/i);
    assert.match(`${label('Superrank')} ${join_('Superrank', 'subIndustry')} ${join_('Superrank', 'productsServices')}`, /seo|search|geo|aeo|organic|growth/i);
    assert.equal(results.Superrank.p.fields.businessModel.value?.model, 'saas');
  });

  test('MOBILISE: resolved from its own pages as a B2B marketing agency; pricing model stays unverified', () => {
    assert.match(label('MOBILISE'), /marketing|advertis/i);
    assert.match(join_('MOBILISE', 'targetCustomers'), /enterprise|brand|compan/i);
    assert.ok(['agency', 'professional-services', 'consultancy'].includes(results.MOBILISE.p.fields.businessModel.value?.model));
    assert.equal(results.MOBILISE.p.fields.businessModel.value?.pricing ?? null, null, 'no pricing model is published, so none may be asserted');
  });

  test('Admizz: study-abroad education consultancy for students', () => {
    assert.match(`${label('Admizz Education')} ${join_('Admizz Education', 'subIndustry')}`, /education|study|consult|admission/i);
    assert.match(join_('Admizz Education', 'targetCustomers'), /student/i);
  });

  test('Chayce: senior relocation and downsizing for older people', () => {
    assert.match(`${label('Chayceproperties')} ${join_('Chayceproperties', 'subIndustry')} ${join_('Chayceproperties', 'productsServices')}`, /relocat|removal|downsiz|mov/i);
    assert.match(join_('Chayceproperties', 'targetCustomers'), /elder|senior|older|retire|famil/i);
  });

  test('Zunkiree Labs: its actual business is read from its own pages (AI and software)', () => {
    assert.match(`${label('Zunkiree Labs')} ${join_('Zunkiree Labs', 'subIndustry')} ${join_('Zunkiree Labs', 'productsServices')}`, /ai|artificial|software|agent/i);
  });

  test('token usage is recorded and stays within a sane budget (one call per project)', () => {
    const per = Object.fromEntries(Object.entries(results).map(([n, r]) => [n, r.used]));
    const total = probe.usageSnapshot();
    console.log('TOKEN USAGE per project (this run; cached responses show 0):', JSON.stringify(per));
    console.log('TOKEN USAGE total since start:', JSON.stringify({ calls: total.calls - usageStart.calls, in: total.inputTokens - usageStart.inputTokens, out: total.outputTokens - usageStart.outputTokens }));
    assert.ok(total.calls - usageStart.calls <= SITES.length * 2, 'at most two model calls per project (one, plus the JSON-correction retry)');
    assert.ok(total.inputTokens - usageStart.inputTokens < 200000);
    for (const [n, r] of Object.entries(results)) console.log(`PROFILE ${n}: ${r.p.fields.ownIndustry.value?.label} | sub: ${r.p.fields.subIndustry.value} | model: ${JSON.stringify(r.p.fields.businessModel.value)} | customers: ${join_(n, 'targetCustomers').slice(0, 140)} | cust-industries: ${join_(n, 'targetCustomerIndustries').slice(0, 100)}`);
  });
});
