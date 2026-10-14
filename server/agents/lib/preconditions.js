// "Can this work actually succeed?" — asked BEFORE generation, not after.
//
// The existing pre-flight (verifyRecommendation) answers a different and
// narrower question: "is the requested outcome already true?". It cannot
// answer "is this tenant even capable of receiving this artifact", and that
// is where the real waste is. The canonical case on this platform is 116
// abandoned Admizz drafts: each one cost a paid LLM call and a GitHub read,
// then failed at APPLY time against a condition that was knowable before a
// single token was generated.
//
// expand-content-structural-fit.js is the existing proof the pattern works —
// it refuses to generate prose for a page whose template has no prose region
// at all, and it was written for exactly this reason. This module generalises
// that one check into a registry, so a new precondition is a new entry rather
// than another `if` inside the ship loop.
//
// THE TRI-STATE CONTRACT, copied from checkExpandContentStructuralFit:
//
//   { ok: true }                 — go ahead
//   { ok: false, reason, detail }— refuse; this will fail if attempted
//   null                         — the check could not run (no repo, no
//                                  mapping, fetch failed)
//
// `null` is NOT a refusal, and that distinction is the whole safety
// property: a check that cannot see the tenant must not be able to stop the
// tenant's work. Treating "I could not look" as "it is broken" would take a
// site's output to zero the moment GitHub had a bad minute.

export const PRECONDITION_SEVERITY = Object.freeze({
  // Attempting this is certain to fail. Refuse before spending anything.
  BLOCKING: 'blocking',
  // Worth recording, but not worth refusing over.
  ADVISORY: 'advisory',
});

// Each check is { id, appliesTo(ctx) => boolean, run(ctx) => tri-state,
// severity }. Registered rather than hard-coded so Phase 3's design
// completeness and TSX-contract checks drop in here without touching the
// aggregator or the ship loop.
const CHECKS = [];

export function registerPrecondition(check) {
  if (!check?.id || typeof check.run !== 'function') {
    throw new Error('registerPrecondition: a check needs an id and a run()');
  }
  // Replace by id, so a re-register (a test, a hot reload) does not stack
  // two copies of the same check and double-count its result.
  const existing = CHECKS.findIndex((c) => c.id === check.id);
  if (existing >= 0) CHECKS.splice(existing, 1, check);
  else CHECKS.push(check);
  return check.id;
}

export function clearPreconditions() {
  CHECKS.length = 0;
}

export function registeredPreconditionIds() {
  return CHECKS.map((c) => c.id);
}

export function isPreconditionsEnforcing(env = process.env) {
  return env.PRECONDITION_CHECKS_ENABLED === 'true';
}

/**
 * Run every applicable check for one piece of pending work.
 *
 * ctx: { site, siteId, actionType, generatorId, params, pageUrl, pageRole }
 *
 * Returns:
 *   { ok: true,  checked, skipped, advisories }
 *   { ok: false, checked, failures, advisories, reason, detail }
 *
 * Checks run in PARALLEL and all of them run, even once one has failed.
 * That is deliberate: a draft refused for two independent reasons should say
 * so, because fixing only the first would send it straight back here. The
 * cost is bounded — these are repo reads and profile lookups, not
 * generations, which is the entire point.
 */
export async function checkPreconditions(ctx = {}) {
  const applicable = CHECKS.filter((c) => {
    try {
      return typeof c.appliesTo === 'function' ? c.appliesTo(ctx) === true : true;
    } catch {
      // A check whose own applicability test throws is treated as not
      // applicable. A broken check must not become a blocker.
      return false;
    }
  });

  if (!applicable.length) return { ok: true, checked: [], skipped: [], advisories: [] };

  const results = await Promise.all(applicable.map(async (c) => {
    try {
      const result = await c.run(ctx);
      return { id: c.id, severity: c.severity || PRECONDITION_SEVERITY.BLOCKING, result };
    } catch (err) {
      // A thrown check is "could not run", not "refused" — same reasoning as
      // the tri-state null.
      return { id: c.id, severity: c.severity || PRECONDITION_SEVERITY.BLOCKING, result: null, error: err.message };
    }
  }));

  const checked = [];
  const skipped = [];
  const failures = [];
  const advisories = [];

  for (const r of results) {
    if (r.result == null) { skipped.push({ id: r.id, ...(r.error ? { error: r.error } : {}) }); continue; }
    checked.push(r.id);
    if (r.result.ok) continue;
    const entry = { id: r.id, reason: r.result.reason || r.id, detail: r.result.detail || null };
    if (r.severity === PRECONDITION_SEVERITY.ADVISORY) advisories.push(entry);
    else failures.push(entry);
  }

  if (!failures.length) return { ok: true, checked, skipped, advisories };

  return {
    ok: false,
    checked,
    skipped,
    advisories,
    failures,
    // The first failure's reason is the machine-readable one, for the
    // existing blocked_reason path; `detail` names them all, because a human
    // reading it needs the whole list.
    reason: failures[0].reason,
    detail: failures.map((f) => f.detail || f.reason).join(' '),
  };
}

// ---------------------------------------------------------------------------
// The checks that can be written TODAY. Phase 3's design-completeness and
// TSX-contract checks register themselves the same way.
// ---------------------------------------------------------------------------

const PROSE_ACTION_TYPES = new Set(['expand-content', 'qa-content', 'faq', 'direct-answer']);

// Wraps the existing structural-fit check rather than reimplementing it, so
// there is one answer to "does this page have a prose region" and it cannot
// drift. Already called directly by expand-content.js; registering it here
// moves the refusal EARLIER, to before the queue spends a slot on the item.
export const structuralFitCheck = {
  id: 'structural-fit',
  severity: PRECONDITION_SEVERITY.BLOCKING,
  appliesTo: (ctx) => PROSE_ACTION_TYPES.has(ctx.actionType) && Boolean(ctx.site && ctx.pageUrl),
  async run(ctx) {
    const { checkExpandContentStructuralFit } = await import('../../generators/lib/expand-content-structural-fit.js');
    const fit = await checkExpandContentStructuralFit(ctx.site, ctx.pageUrl);
    if (fit == null) return null;
    return fit.ok ? { ok: true } : { ok: false, reason: 'no-prose-region', detail: fit.detail };
  },
};

// A measured regression already banned this exact work on this exact page.
// auto-remediation.js checks this when building its eligible set; having it
// here too means every OTHER producer gets the same protection by calling
// one function, instead of each remembering to read the table.
export const fixSuppressedCheck = {
  id: 'fix-suppressed',
  severity: PRECONDITION_SEVERITY.BLOCKING,
  appliesTo: (ctx) => Boolean(ctx.siteId && ctx.generatorId && (ctx.pageUrl || ctx.params?.page)),
  async run(ctx) {
    const { getSuppressionSet, isSuppressed, isSuppressionEnforcing } = await import('../../store/fix-suppressions.js');
    if (!isSuppressionEnforcing()) return null;
    const set = await getSuppressionSet(ctx.siteId);
    const scopeKey = ctx.pageUrl || ctx.params?.page;
    return isSuppressed(set, { scope: 'page', scopeKey, generatorId: ctx.generatorId })
      ? { ok: false, reason: 'fix-suppressed', detail: `A measured regression from a previous ${ctx.generatorId} fix on this page banned this work here.` }
      : { ok: true };
  },
};

// A product generator with nothing verified to write from will either
// fabricate or be rejected by the positioning guard after the fact. Advisory
// rather than blocking: 'proposed' knowledge exists for exactly this case
// (migration 176), and a human confirming one row turns this off — refusing
// outright would mean a product tenant whose admin has not finished the form
// ships nothing at all, which is the failure mode this phase set out to fix.
const PRODUCT_COPY_ACTION_TYPES = new Set(['landing-page', 'blog-outline', 'direct-answer', 'faq']);

export const productKnowledgeCheck = {
  id: 'product-knowledge',
  severity: PRECONDITION_SEVERITY.ADVISORY,
  appliesTo: (ctx) => ctx.site?.property_type === 'product' && PRODUCT_COPY_ACTION_TYPES.has(ctx.actionType),
  async run(ctx) {
    const { loadTenantContext } = await import('../../lib/tenant-context.js');
    const tenant = await loadTenantContext(ctx.siteId, { site: ctx.site });
    if (!tenant) return null;
    return tenant.productKnowledge?.length
      ? { ok: true }
      : { ok: false, reason: 'no-verified-product-knowledge', detail: 'This product tenant has no verified product knowledge, so the copy has nothing real to describe the product from.' };
  },
};

// Design completeness BEFORE generation: today a thin profile is discovered
// at apply time, after a paid LLM call — the same waste structural-fit exists
// to stop. Only active under DESIGN_GATE_FAIL_CLOSED, the same flag as the
// apply-time gate, so the two can never disagree about whether to enforce.
export const designCompletenessCheck = {
  id: 'design-completeness',
  severity: PRECONDITION_SEVERITY.BLOCKING,
  appliesTo: (ctx) => Boolean(ctx.site && ctx.actionType),
  async run(ctx) {
    const { assessDesignCompleteness, isDesignGateFailClosed, describeBlocks } = await import('../../design-agent/lib/design-completeness.js');
    if (!isDesignGateFailClosed()) return null;
    const a = assessDesignCompleteness(ctx.site?.url_file_map?.siteRoot?.designProfile || null, {
      actionType: ctx.actionType, pageRole: ctx.pageRole || null,
      inlineProse: ctx.site?.url_file_map?.siteRoot?.inlineProse || null,
    });
    return a.ok ? { ok: true } : { ok: false, reason: 'design-incomplete', detail: describeBlocks(a) };
  },
};

export const tsxContractCheck = {
  id: 'tsx-component-contract',
  severity: PRECONDITION_SEVERITY.BLOCKING,
  appliesTo: (ctx) => Boolean(ctx.site && ['blog-outline', 'direct-answer', 'translation'].includes(ctx.actionType)),
  async run(ctx) {
    const { checkGeneratedComponentContract } = await import('../../generators/lib/tsx-component-contract.js');
    const r = await checkGeneratedComponentContract(ctx.site, ctx.actionType);
    return r == null ? null : (r.ok ? { ok: true } : { ok: false, reason: r.reason, detail: r.detail });
  },
};

export const BUILTIN_CHECKS = Object.freeze([structuralFitCheck, fixSuppressedCheck, productKnowledgeCheck, designCompletenessCheck, tsxContractCheck]);

// Registered on import, so a caller gets the real set by calling
// checkPreconditions and needs no setup. Exported individually above so each
// one's applicability is testable without a repo or a database.
export function registerBuiltinPreconditions() {
  for (const c of BUILTIN_CHECKS) registerPrecondition(c);
  return registeredPreconditionIds();
}

registerBuiltinPreconditions();
