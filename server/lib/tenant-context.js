// What this tenant is, what it sells, and what it is trying to achieve —
// loaded once and shared, so every agent and generator reasons from the same
// picture.
//
// The problem this solves: the facts already exist, and almost nothing reads
// them. Active goals reach exactly two call sites (recommendations.js and
// analyst-fusion.js), and only to nudge a priority score. Growth config
// reaches only prospect-discovery. Verified product knowledge reaches only
// the landing-page generator. So a blog outline for a product tenant is
// written from a homepage excerpt with no idea what the product does, who it
// is for, or which goal it is meant to serve — and then a separate
// positioning guard checks the finished draft against facts the writer was
// never shown.
//
// This is deliberately a composition of existing readers, not a new store:
// nothing here queries a table directly, so there is no second source of
// truth to drift.
//
// EVERY READER IS IMPORTED LAZILY, inside loadTenantContext. That is not
// style — this module is imported by ~10 generators and agents, and a static
// import chain would pull store/data-analyst.js, store/read.js and the rest
// into the eager module graph of every one of them. This repo's tests mock
// those stores with `mock.module` and a PARTIAL set of named exports, so an
// eager chain turns any missing export into a SyntaxError at instantiate
// time, in a test that never asked for tenant context at all (confirmed:
// trend-radar.test.js mocks data-analyst.js without getProductKnowledge).
// Deferring the import also means that with the flag off, nothing here is
// loaded or executed at all.

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function fromCache(siteId) {
  const hit = cache.get(siteId);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(siteId);
    return null;
  }
  return hit.value;
}

export function clearTenantContextCache(siteId = null) {
  if (siteId == null) cache.clear();
  else cache.delete(siteId);
}

// Every lookup is independently optional. A tenant that has never been
// through product onboarding, or whose GSC-fed profile does not exist yet,
// must still get a usable context rather than an exception — the caller's
// job is to generate something, and missing context degrades the prompt, it
// does not invalidate the request.
async function soft(promise, fallback) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

export async function loadTenantContext(siteId, { site: siteArg = null, refresh = false } = {}) {
  if (!refresh) {
    const cached = fromCache(siteId);
    if (cached) return cached;
  }

  const [
    { getSiteById },
    { listActiveGoals },
    { getProductKnowledge, getSiteProfile },
    { getProductGrowthConfig },
    { getSeoPolicy },
    { computeSiteCapabilities },
    { tenantIndustries },
    { formatProductFacts },
  ] = await Promise.all([
    import('../store/read.js'),
    import('../store/site-goals.js'),
    import('../store/data-analyst.js'),
    import('../store/product-growth-config.js'),
    import('../store/site-seo-policy.js'),
    import('./site-capabilities.js'),
    import('../agents/lib/seo-tenant-context.js'),
    import('../generators/lib/product-facts.js'),
  ]);

  const site = siteArg || await soft(getSiteById(siteId), null);
  if (!site) return null;

  const isProduct = site.property_type === 'product';

  const [goals, seoPolicy, siteProfile, growthConfig, productKnowledge] = await Promise.all([
    soft(listActiveGoals(siteId), []),
    soft(getSeoPolicy(siteId), null),
    soft(getSiteProfile(siteId), null),
    isProduct ? soft(getProductGrowthConfig(siteId), null) : Promise.resolve(null),
    // 'verified' only, matching loadProductFactsFor: a proposed row is a
    // suggestion awaiting human confirmation and must never be stated to a
    // model as fact.
    isProduct ? soft(getProductKnowledge(siteId, 'verified'), []) : Promise.resolve([]),
  ]);

  // Industry resolution, most specific first. tenantIndustries already
  // encodes the policy-then-profile precedence; growth config is the
  // product-only third source it predates, and is the only one captured at
  // onboarding rather than inferred from GSC — which is what makes it the
  // sole source available to a product tenant with no Search Console.
  const industries = tenantIndustries(seoPolicy, siteProfile)
    || (growthConfig?.industries?.length ? growthConfig.industries : null);

  const value = {
    site,
    siteId,
    propertyType: site.property_type || 'website',
    isProduct,
    capabilities: computeSiteCapabilities(site),
    goals,
    seoPolicy,
    siteProfile,
    growthConfig,
    productKnowledge,
    // Rendered here rather than in the formatter so the formatter stays pure
    // AND dependency-free — reusing the landing-page generator's own
    // formatter means every generator states product facts identically, and
    // the positioning guard checks against what was actually said.
    productFactsText: productKnowledge?.length ? (formatProductFacts(productKnowledge) || '') : '',
    industries,
    markets: growthConfig?.markets?.length ? growthConfig.markets : null,
    icpSignals: growthConfig?.icp_signals ?? null,
    conversionEvent: growthConfig?.conversion_event ?? null,
  };

  cache.set(siteId, { at: Date.now(), value });
  return value;
}

// Pure, deterministic prompt text. Separated from loading so it can be unit
// tested without a database, and so a caller can take only the sections it
// needs — a FAQ generator has no use for the ICP, and every unused line is
// paid for on every call.
//
// Returns '' when there is nothing real to say. An empty context must leave
// a prompt byte-for-byte as it was: a heading with nothing under it invites
// the model to fill the gap, which is exactly the fabrication this is meant
// to prevent.
export const TENANT_CONTEXT_SECTIONS = Object.freeze([
  'business', 'goals', 'product', 'audience',
]);

export function formatTenantContextForPrompt(ctx, { sections = TENANT_CONTEXT_SECTIONS, maxGoals = 3 } = {}) {
  if (!ctx) return '';
  const want = new Set(sections);
  const parts = [];

  if (want.has('business') && ctx.industries?.length) {
    parts.push(`This site's industry: ${ctx.industries.join(', ')}.`);
  }

  if (want.has('goals') && ctx.goals?.length) {
    // `objective` is required at creation and is the human sentence; goalType
    // alone is explicitly documented as "not specific enough" (createGoal),
    // so it is only ever a last-resort label here. Already ordered by
    // importance by listActiveGoals.
    const lines = ctx.goals.slice(0, maxGoals).map((g) => {
      const metric = g.primaryMetric ? ` (measured by ${g.primaryMetric})` : '';
      return `- ${g.objective || g.description || g.goalType}${metric}`;
    });
    parts.push(`What this business is trying to achieve:\n${lines.join('\n')}`);
  }

  if (want.has('product') && ctx.productFactsText) {
    parts.push(`Verified facts about this product — use these, never invent others:\n${ctx.productFactsText}`);
  }

  if (want.has('audience')) {
    const audience = [];
    if (ctx.markets?.length) audience.push(`Target markets: ${ctx.markets.join(', ')}.`);
    if (ctx.icpSignals?.length) {
      const signals = Array.isArray(ctx.icpSignals) ? ctx.icpSignals : [ctx.icpSignals];
      audience.push(`Ideal customer signals: ${signals.join(', ')}.`);
    }
    if (audience.length) parts.push(audience.join(' '));
  }

  return parts.join('\n\n');
}

// Only the PROMPT injection is flagged, not the loader. More context can
// degrade generation as easily as improve it, and a generator's output is
// the one thing here that reaches a client's repository — so the text stays
// off until it has been A/B'd. Code that uses the context to make a decision
// (classifyGapRelevance, which without it cannot ship a single keyword gap
// for a product tenant) is not behind this flag: that is a bug fix, not a
// prompt experiment.
export function isTenantContextEnabled(env = process.env) {
  return env.TENANT_CONTEXT_ENABLED === 'true';
}

// Convenience for a caller that has a site row and wants the text in one
// step. Mirrors loadProductFactsFor's contract exactly — '' on any failure,
// so an existing prompt is never broken by this being unavailable.
export async function tenantContextTextFor(site, options = {}) {
  if (!site?.id) return '';
  if (!isTenantContextEnabled()) return '';
  const ctx = await loadTenantContext(site.id, { site }).catch(() => null);
  return formatTenantContextForPrompt(ctx, options);
}

// Same contract for a caller that has only an id — the orchestrator and the
// copilot both work from a siteId and never hold the row.
export async function tenantContextTextForSiteId(siteId, options = {}) {
  if (siteId == null) return '';
  if (!isTenantContextEnabled()) return '';
  const ctx = await loadTenantContext(siteId).catch(() => null);
  return formatTenantContextForPrompt(ctx, options);
}
