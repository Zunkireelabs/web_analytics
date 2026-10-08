import { getOrCreateProductId } from '../store/products.js';
import { saveProductGrowthConfig, getProductGrowthConfig } from '../store/product-growth-config.js';
import { saveSiteProfile, getSiteProfile, proposeProductCapability, createProductCapability } from '../store/data-analyst.js';
import { createGoal, listGoals, GOAL_TYPES } from '../store/site-goals.js';
import { resolveIndustry } from './industry-capture.js';
import { ensureAnalystClient } from './tenant-provisioning.js';

// Everything a PRODUCT tenant needs in order to actually run, applied in one
// call, so "created" and "working" stop being different things for products
// the way tenant-provisioning.js already made them the same for websites.
//
// Why this exists: creating a product tenant writes exactly ONE row — the
// `sites` row with property_type='product'. Everything that makes the
// product agents do anything (a products row, a growth config, a conversion
// event, an industry, a goal, capability rows) had to be added afterwards
// through three separate manual admin routes that nothing reminded anyone
// to visit. The result was a tenant that logged in fine and shipped nothing,
// and assessTenantReadiness said it was ready, because until now it only
// checked website preconditions.
//
// Deliberately idempotent in every step, and re-runnable: the natural way
// this gets used is to create a tenant with what is known on day one and
// re-run it when the rest arrives.
//
// Every dependency is injectable for the same reason the rest of this
// directory does it — one fake per test, no database.

export const DEFAULT_PRODUCT_GOAL_TYPE = 'grow_signups';

// The deps object is flat and explicit rather than a module-mock, so a
// caller (the route, the script, a test) can substitute exactly one step.
const DEFAULT_DEPS = {
  getOrCreateProductId,
  saveProductGrowthConfig,
  getProductGrowthConfig,
  saveSiteProfile,
  getSiteProfile,
  createGoal,
  listGoals,
  createProductCapability,
  proposeProductCapability,
  ensureAnalystClient,
  // Optional: the LLM homepage classification tier. Left out entirely by
  // default so no caller pays for a model call it did not ask for.
  classifyIndustry: null,
  queueDesignProfileDerivation: null,
};

// Each step reports its own outcome and NEVER throws into the caller. A
// product tenant half-provisioned is the normal case, not an error — what
// matters is that the caller can see precisely which parts landed, which is
// what the `steps` array is. An exception here would instead abort the rest
// of a sequence whose remaining steps are independent.
async function step(name, fn) {
  try {
    const result = await fn();
    return { step: name, ok: true, ...result };
  } catch (err) {
    return { step: name, ok: false, error: err.message };
  }
}

export async function provisionProductTenant(site, {
  industry = null,
  markets = null,
  icpSignals = null,
  conversionEvent = null,
  goals = [],
  capabilities = [],
  proposedCapabilities = [],
  homepageText = null,
  deps = {},
} = {}) {
  if (site?.property_type !== 'product') {
    return { ok: false, reason: 'not-a-product-tenant', steps: [] };
  }
  const d = { ...DEFAULT_DEPS, ...deps };
  const siteId = site.id;
  const steps = [];

  // 1. The products row. Everything product-mode keys on product_id, not
  //    site_id, so nothing below can be written without this.
  steps.push(await step('product-row', async () => {
    const productId = await d.getOrCreateProductId(siteId);
    return { productId };
  }));

  // 2. Growth config. Merged, never replaced: saveProductGrowthConfig is a
  //    full-row upsert, so passing only the markets on a re-run would wipe
  //    an existing conversion event. Read first, then write the union.
  steps.push(await step('growth-config', async () => {
    const existing = await d.getProductGrowthConfig(siteId).catch(() => null);
    const industries = industry ? [industry] : (existing?.industries ?? []);
    const next = {
      conversionEvent: conversionEvent ?? existing?.conversion_event ?? null,
      markets: markets ?? existing?.markets ?? [],
      industries,
      icpSignals: icpSignals ?? existing?.icp_signals ?? [],
      crmConfig: existing?.crm_config ?? {},
      outreachEnabled: existing?.outreach_enabled === true,
      competitorSignals: existing?.competitor_signals ?? [],
    };
    await d.saveProductGrowthConfig(siteId, next);
    return { conversionEvent: next.conversionEvent, markets: next.markets, industries: next.industries };
  }));

  // 3. Industry, with its provenance. This is the step that makes trend
  //    radar possible at all for a product tenant — see industry-capture.js
  //    for why a product tenant can never get one any other way.
  steps.push(await step('industry', async () => {
    const existing = await d.getSiteProfile(siteId).catch(() => null);
    // A human-set industry already on file is left alone. The CASE in
    // saveSiteProfile enforces this at the SQL level too; checking here as
    // well means we also skip a pointless LLM call for it.
    if (existing?.industry && existing.industry_source === 'human' && !industry) {
      return { industry: existing.industry, source: 'human', skipped: 'already-human-set' };
    }

    const growth = await d.getProductGrowthConfig(siteId).catch(() => null);
    let classified = null;
    // The LLM tier runs ONLY when the two real sources came back empty —
    // a classification is the weakest evidence here and the only one that
    // costs money.
    if (!industry && !growth?.industries?.length && homepageText && d.classifyIndustry) {
      classified = await d.classifyIndustry(homepageText).catch(() => null);
    }

    const resolved = resolveIndustry({ explicit: industry, growthIndustries: growth?.industries, classified });
    if (!resolved.industry) return { industry: null, source: null, skipped: 'nothing-to-record' };

    await d.saveSiteProfile(siteId, {
      industry: resolved.industry,
      // mainTopics/siteType are not ours to assert — site_profiles is
      // otherwise written by the Python clustering collector, and passing
      // anything here would overwrite its real inference with a guess.
      // Reading the existing row back preserves whatever it found.
      mainTopics: existing?.main_topics ?? [],
      siteType: existing?.site_type ?? 'product',
      industrySource: resolved.source,
      industryConfidence: resolved.confidence,
    });
    return { industry: resolved.industry, source: resolved.source, confidence: resolved.confidence, mappable: resolved.mappable };
  }));

  // 4. Goals. Without one, every recommendation scores identically and
  //    nothing can be prioritised — see pickBestGoalAlignment.
  steps.push(await step('goals', async () => {
    const existing = await d.listGoals(siteId).catch(() => []);
    if (existing.length) return { created: 0, existing: existing.length, skipped: 'already-has-goals' };

    const created = [];
    for (const g of goals) {
      const goalType = GOAL_TYPES.includes(g?.goalType) ? g.goalType : DEFAULT_PRODUCT_GOAL_TYPE;
      // `objective` is required and is NOT defaulted to a generic sentence:
      // createGoal rejects an empty one precisely because the type alone is
      // "not specific enough to match findings against", and inventing
      // "Grow signups" here would satisfy the check while giving the
      // evaluator nothing real to match against. A goal with no objective
      // is skipped and stays visible as a missing precondition.
      if (!g?.objective?.trim()) continue;
      created.push(await d.createGoal(siteId, {
        goalType,
        objective: g.objective.trim(),
        primaryMetric: g.primaryMetric ?? null,
        importance: Number.isInteger(g.importance) ? g.importance : created.length + 1,
      }));
    }
    return { created: created.length, skippedNoObjective: goals.length - created.length };
  }));

  // 5. Product knowledge. Two paths, kept strictly apart: anything a human
  //    asserted is 'verified' and immediately usable; anything extracted by
  //    an agent is 'proposed' and invisible to every generator until a human
  //    confirms it. getProductKnowledge's 'verified' default is what enforces
  //    that, so this needs no gate of its own.
  steps.push(await step('capabilities', async () => {
    let verified = 0;
    let proposed = 0;
    for (const c of capabilities) {
      if (!c?.name) continue;
      await d.createProductCapability(siteId, c);
      verified++;
    }
    for (const c of proposedCapabilities) {
      if (!c?.name) continue;
      const row = await d.proposeProductCapability(siteId, c);
      if (row) proposed++;
    }
    return { verified, proposed };
  }));

  // 6. The Data Analyst client — the same call website onboarding makes.
  //    Without it the nightly Python pipeline never iterates this tenant.
  steps.push(await step('analyst-client', async () => {
    const result = await d.ensureAnalystClient(site);
    if (!result.ok) throw new Error(result.error || result.reason);
    return { hasMcpToken: result.hasMcpToken === true };
  }));

  // 7. Design profile derivation, only when there is a repo to derive from.
  //    Queued, not awaited — it runs in the Design Agent worker.
  if (d.queueDesignProfileDerivation && site.repo_owner && site.repo_name) {
    steps.push(await step('design-profile', async () => {
      await d.queueDesignProfileDerivation(site);
      return { queued: true };
    }));
  }

  const failed = steps.filter((s) => !s.ok);
  return { ok: failed.length === 0, siteId, steps, failed };
}

// One-line-per-step console output, matching printReadiness' shape so the
// script's output reads as one continuous report rather than two formats.
export function printProvisioning(result, log = console.log) {
  log('\nProduct provisioning:');
  for (const s of result.steps) {
    const detail = s.ok
      ? Object.entries(s).filter(([k]) => !['step', 'ok'].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
      : s.error;
    log(`  [${s.ok ? 'ok  ' : 'FAIL'}] ${s.step}${detail ? `: ${detail}` : ''}`);
  }
}
