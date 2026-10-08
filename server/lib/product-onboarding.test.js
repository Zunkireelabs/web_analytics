import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { provisionProductTenant, DEFAULT_PRODUCT_GOAL_TYPE } from './product-onboarding.js';

const productSite = (over = {}) => ({ id: 77, name: 'Some SaaS', property_type: 'product', ...over });

// One recording fake per dependency, so each test asserts on what was
// actually written rather than on a return value.
function fakes(over = {}) {
  const calls = { growth: [], profile: [], goals: [], verified: [], proposed: [], analyst: [], design: [] };
  const deps = {
    getOrCreateProductId: async () => 900,
    getProductGrowthConfig: async () => null,
    saveProductGrowthConfig: async (siteId, cfg) => { calls.growth.push({ siteId, cfg }); },
    getSiteProfile: async () => null,
    saveSiteProfile: async (siteId, p) => { calls.profile.push({ siteId, ...p }); },
    listGoals: async () => [],
    createGoal: async (siteId, g) => { calls.goals.push(g); return { id: calls.goals.length, ...g }; },
    createProductCapability: async (siteId, c) => { calls.verified.push(c); return { id: 1, ...c }; },
    proposeProductCapability: async (siteId, c) => { calls.proposed.push(c); return { id: 2, ...c, status: 'proposed' }; },
    ensureAnalystClient: async (site) => { calls.analyst.push(site.id); return { ok: true, hasMcpToken: false }; },
    ...over,
  };
  return { calls, deps };
}

const stepOf = (result, name) => result.steps.find((s) => s.step === name);

describe('provisionProductTenant', () => {
  test('refuses a website tenant outright rather than writing product rows for it', async () => {
    const out = await provisionProductTenant({ id: 1, property_type: 'website' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not-a-product-tenant');
    assert.deepEqual(out.steps, []);
  });

  test('a full provisioning writes every piece and reports ok', async () => {
    const { calls, deps } = fakes();
    const out = await provisionProductTenant(productSite(), {
      industry: 'education',
      markets: ['Nepal'],
      icpSignals: ['counsellors'],
      conversionEvent: 'trial_signup',
      goals: [{ goalType: 'grow_signups', objective: 'Reach 200 trial signups a month', primaryMetric: 'trial_signups' }],
      capabilities: [{ name: 'Application tracking', kind: 'capability' }],
      deps,
    });

    assert.equal(out.ok, true);
    assert.equal(calls.growth[0].cfg.conversionEvent, 'trial_signup');
    assert.deepEqual(calls.growth[0].cfg.industries, ['education']);
    assert.equal(calls.profile[0].industry, 'education');
    assert.equal(calls.profile[0].industrySource, 'human');
    assert.equal(calls.profile[0].industryConfidence, 'high');
    assert.equal(calls.goals[0].objective, 'Reach 200 trial signups a month');
    assert.deepEqual(calls.verified, [{ name: 'Application tracking', kind: 'capability' }]);
    assert.deepEqual(calls.analyst, [77]);
  });

  test('a re-run with only the markets does not wipe the conversion event', async () => {
    // saveProductGrowthConfig is a full-row upsert, so a partial re-run
    // would otherwise silently clear whatever it was not given.
    const { calls, deps } = fakes({
      getProductGrowthConfig: async () => ({
        conversion_event: 'demo_booked', markets: ['India'], industries: ['education'],
        icp_signals: ['counsellors'], crm_config: { kind: 'hubspot' }, outreach_enabled: true, competitor_signals: ['x'],
      }),
    });

    await provisionProductTenant(productSite(), { markets: ['Nepal', 'India'], deps });

    const cfg = calls.growth[0].cfg;
    assert.equal(cfg.conversionEvent, 'demo_booked');
    assert.deepEqual(cfg.markets, ['Nepal', 'India']);
    assert.deepEqual(cfg.industries, ['education']);
    assert.deepEqual(cfg.icpSignals, ['counsellors']);
    assert.deepEqual(cfg.crmConfig, { kind: 'hubspot' });
    assert.equal(cfg.outreachEnabled, true);
  });

  test('the industry falls back to the growth config when none is passed', async () => {
    const { calls, deps } = fakes({ getProductGrowthConfig: async () => ({ industries: ['healthcare'] }) });
    await provisionProductTenant(productSite(), { deps });

    assert.equal(calls.profile[0].industry, 'healthcare');
    assert.equal(calls.profile[0].industrySource, 'growth-config');
    assert.equal(calls.profile[0].industryConfidence, 'medium');
  });

  test('an LLM classification runs ONLY when both real sources are empty', async () => {
    let classifyCalls = 0;
    const classifyIndustry = async () => { classifyCalls++; return 'technology'; };

    const withHuman = fakes({ classifyIndustry });
    await provisionProductTenant(productSite(), { industry: 'education', homepageText: 'text', deps: withHuman.deps });
    assert.equal(classifyCalls, 0, 'a human value must never trigger a paid call');

    const withGrowth = fakes({ classifyIndustry, getProductGrowthConfig: async () => ({ industries: ['wellness'] }) });
    await provisionProductTenant(productSite(), { homepageText: 'text', deps: withGrowth.deps });
    assert.equal(classifyCalls, 0, 'the growth config must never trigger a paid call either');

    const bare = fakes({ classifyIndustry });
    await provisionProductTenant(productSite(), { homepageText: 'text', deps: bare.deps });
    assert.equal(classifyCalls, 1);
    assert.equal(bare.calls.profile[0].industrySource, 'llm-classified');
    assert.equal(bare.calls.profile[0].industryConfidence, 'low');
  });

  test('an industry the trend-feed catalog cannot serve is recorded as unmapped, not as working', async () => {
    const { calls, deps } = fakes();
    const out = await provisionProductTenant(productSite(), { industry: 'artisanal coffee roasting', deps });

    assert.equal(calls.profile[0].industrySource, 'unmapped');
    assert.equal(stepOf(out, 'industry').mappable, false);
  });

  test('an existing human-set industry is left alone, and costs no model call', async () => {
    let classifyCalls = 0;
    const { calls, deps } = fakes({
      getSiteProfile: async () => ({ industry: 'education', industry_source: 'human' }),
      classifyIndustry: async () => { classifyCalls++; return 'technology'; },
    });

    const out = await provisionProductTenant(productSite(), { homepageText: 'text', deps });

    assert.equal(calls.profile.length, 0);
    assert.equal(classifyCalls, 0);
    assert.equal(stepOf(out, 'industry').skipped, 'already-human-set');
  });

  test('the Python collector\'s own main_topics and site_type are preserved, never overwritten with a guess', async () => {
    const { calls, deps } = fakes({
      getSiteProfile: async () => ({ industry: 'technology', industry_source: 'inferred', main_topics: ['cloud', 'devops'], site_type: 'service' }),
    });
    await provisionProductTenant(productSite(), { industry: 'education', deps });

    assert.deepEqual(calls.profile[0].mainTopics, ['cloud', 'devops']);
    assert.equal(calls.profile[0].siteType, 'service');
  });

  test('a goal with no objective is skipped rather than given an invented one', async () => {
    // createGoal rejects an empty objective because the goal type alone is
    // "not specific enough to match findings against". Defaulting a sentence
    // here would pass that check and give the evaluator nothing real.
    const { calls, deps } = fakes();
    const out = await provisionProductTenant(productSite(), {
      goals: [{ goalType: 'grow_signups' }, { goalType: 'book_demos', objective: 'Book 20 demos a month' }],
      deps,
    });

    assert.equal(calls.goals.length, 1);
    assert.equal(calls.goals[0].objective, 'Book 20 demos a month');
    assert.equal(stepOf(out, 'goals').skippedNoObjective, 1);
  });

  test('an unknown goal type falls back to a real product goal type instead of throwing', async () => {
    const { calls, deps } = fakes();
    await provisionProductTenant(productSite(), { goals: [{ goalType: 'go_viral', objective: 'Grow fast' }], deps });
    assert.equal(calls.goals[0].goalType, DEFAULT_PRODUCT_GOAL_TYPE);
  });

  test('existing goals are never duplicated on a re-run', async () => {
    const { calls, deps } = fakes({ listGoals: async () => [{ id: 1, objective: 'Already here' }] });
    const out = await provisionProductTenant(productSite(), { goals: [{ objective: 'Another' }], deps });

    assert.equal(calls.goals.length, 0);
    assert.equal(stepOf(out, 'goals').skipped, 'already-has-goals');
  });

  test('agent-extracted capabilities go in as proposed, human ones as verified', async () => {
    const { calls, deps } = fakes();
    const out = await provisionProductTenant(productSite(), {
      capabilities: [{ name: 'Human asserted' }],
      proposedCapabilities: [{ name: 'Read off the homepage' }, { name: '' }],
      deps,
    });

    assert.deepEqual(calls.verified.map((c) => c.name), ['Human asserted']);
    assert.deepEqual(calls.proposed.map((c) => c.name), ['Read off the homepage']);
    assert.equal(stepOf(out, 'capabilities').proposed, 1);
  });

  test('one failing step does not abort the independent steps after it', async () => {
    const { calls, deps } = fakes({ saveProductGrowthConfig: async () => { throw new Error('growth table missing'); } });
    const out = await provisionProductTenant(productSite(), {
      industry: 'education',
      goals: [{ objective: 'Grow signups' }],
      deps,
    });

    assert.equal(out.ok, false);
    assert.deepEqual(out.failed.map((s) => s.step), ['growth-config']);
    assert.equal(stepOf(out, 'growth-config').error, 'growth table missing');
    // The point: the industry and the goal still landed.
    assert.equal(calls.profile.length, 1);
    assert.equal(calls.goals.length, 1);
    assert.deepEqual(calls.analyst, [77]);
  });

  test('an unreachable analyst service is reported as a failed step, not thrown', async () => {
    const { deps } = fakes({ ensureAnalystClient: async () => ({ ok: false, error: 'Data Analyst Agent is unreachable right now' }) });
    const out = await provisionProductTenant(productSite(), { deps });

    assert.equal(out.ok, false);
    assert.match(stepOf(out, 'analyst-client').error, /unreachable/);
  });

  test('design-profile derivation is queued only when a repo is actually connected', async () => {
    const queued = [];
    const withoutRepo = fakes({ queueDesignProfileDerivation: async (s) => { queued.push(s.id); } });
    await provisionProductTenant(productSite(), { deps: withoutRepo.deps });
    assert.deepEqual(queued, []);

    const withRepo = fakes({ queueDesignProfileDerivation: async (s) => { queued.push(s.id); } });
    const out = await provisionProductTenant(productSite({ repo_owner: 'org', repo_name: 'repo' }), { deps: withRepo.deps });
    assert.deepEqual(queued, [77]);
    assert.equal(stepOf(out, 'design-profile').queued, true);
  });

  test('provisioning with nothing known writes the rows it can and records what it could not', async () => {
    // The normal day-one case: a tenant is created before anyone has the
    // industry, the goals or the conversion event.
    const { calls, deps } = fakes();
    const out = await provisionProductTenant(productSite(), { deps });

    assert.equal(out.ok, true, 'knowing nothing is not an error');
    assert.equal(calls.profile.length, 0);
    assert.equal(stepOf(out, 'industry').skipped, 'nothing-to-record');
    assert.equal(stepOf(out, 'capabilities').verified, 0);
    assert.equal(calls.growth.length, 1, 'the growth config row is still created, so the console has something to edit');
  });
});
