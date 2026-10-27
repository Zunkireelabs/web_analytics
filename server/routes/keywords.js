import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { callLLM } from '../llm.js';
import {
  getKeywordClusters, getKeywordGaps, updateKeywordGapStatus, getSiteProfile,
  getLatestKeywordNarrative, getAnomalyAlerts, getLatestForecastStatuses, getGapContentPlan, setGapContentPlan,
  getLatestLayoutSuggestion, saveLayoutSuggestion, createUserKeywordGap,
  getProductCapabilities, createProductCapability, updateProductCapabilityStatus,
} from '../store/data-analyst.js';
import { PRODUCT_KNOWLEDGE_KINDS } from '../lib/product-knowledge-kinds.js';
import { createActionCenterRecommendationForGap, buildProductTopicMap, opportunityDraftEligibility, recommendedActionForGap, classifyGapRelevance } from '../agents/lib/analyst-seo-mapping.js';
import {
  PLANS, normalizeKeyword, recommendPlanForGap, buildHaveKeywords, buildKeywordsOverview, buildPagesOverview,
} from '../agents/lib/keyword-plan.js';
import { gscDailyDataAsOf } from '../store/data-freshness.js';
import { getQueryPageMetrics } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { buildGrowthOpportunities } from '../agents/lib/growth-opportunities.js';
import { translateKeywords } from '../agents/lib/keyword-translation.js';
import { generateDraft } from './action-center.js';
import { getSiteById } from '../store/read.js';

// Matches dataAnalyst.js's ANALYST_DRAFT_DESIGN_WAIT_MS — a short bounded
// wait so a click that lands mid-Design-Agent-derivation gets a real result
// instead of an immediate "come back later", without hanging the request.
const OPPORTUNITY_DRAFT_DESIGN_WAIT_MS = 45_000;

// Keyword Discovery — clusters/gaps/site-profile produced by agents/clustering.py
// (see server/store/data-analyst.js for the read/write layer). Unlike
// server/routes/dataAnalyst.js, these tables live in this app's own Neon
// Postgres already (post schema-merge), so there's no Python proxy here —
// each handler just calls the store function and re-throws through Express's
// error middleware, same thin-passthrough discipline. Staff-only, cross-client,
// same gate as dataAnalyst.js.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

router.get('/internal/keywords/:siteId/clusters', async (req, res, next) => {
  try {
    const { cluster_type: clusterType } = req.query;
    res.json(await getKeywordClusters(req.params.siteId, clusterType));
  } catch (e) { next(e); }
});

// Website-wide Growth Opportunities (Analyst page) — built read-time
// directly from gsc_query_page + keyword_gaps, no persistence, so it's never
// stale the way the 14-day keyword_clusters snapshot is. See
// agents/lib/growth-opportunities.js for the full model and why each
// opportunity type is or isn't produced.
router.get('/internal/keywords/:siteId/growth-opportunities', async (req, res, next) => {
  try {
    res.json(await buildGrowthOpportunities(req.params.siteId));
  } catch (e) { next(e); }
});

// "Send to Action Center" for a Quick Win / Page 1 / Declining / Content
// Expansion growth opportunity — re-validates eligibility server-side (never
// trusts the frontend's own check alone), same discipline as dataAnalyst.js's
// insights/generate-draft route. The opportunity body comes straight from
// buildGrowthOpportunities' own read-time output (no separate persisted
// resource to look up by id), so the frontend just resends the row it
// already has.
router.post('/internal/keywords/:siteId/growth-opportunities/generate-draft', async (req, res, next) => {
  try {
    const site = await getSiteById(req.params.siteId);
    if (!site) { const err = new Error('Client not found.'); err.status = 404; throw err; }
    const { opportunity } = req.body || {};
    const action = opportunityDraftEligibility(site, opportunity);
    if (!action) {
      const err = new Error('This opportunity is not eligible for draft generation.');
      err.status = 400;
      throw err;
    }
    const draft = await generateDraft(site.id, {
      generatorId: action.generatorId, params: action.params,
      source: 'analyst-growth-opportunity', findingId: action.findingId,
      waitForDesignAgent: OPPORTUNITY_DRAFT_DESIGN_WAIT_MS,
    });
    res.json(draft);
  } catch (e) { next(e); }
});

router.get('/internal/keywords/:siteId/gaps', async (req, res, next) => {
  try {
    const { status } = req.query;
    const gaps = await getKeywordGaps(req.params.siteId, status);
    // recommended_action comes from the SAME rules that decide whether a draft is
    // created, so the UI shows what will really happen — not a fixed "Blog post".
    res.json(gaps.map((g) => ({ ...g, recommended_action: recommendedActionForGap(g) })));
  } catch (e) { next(e); }
});

// A keyword the user typed on the Analyst page as a growth target. It enters
// the review queue as a normal pending gap (source 'user_request') rather than
// being acted on immediately — approving it is still the separate, deliberate
// PUT below, so a typo never reaches Action Center on its own.
const MAX_TOPIC_LENGTH = 200;
router.post('/internal/keywords/:siteId/gaps', async (req, res, next) => {
  try {
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    if (!topic) {
      const err = new Error('topic is required.');
      err.status = 400;
      throw err;
    }
    if (topic.length > MAX_TOPIC_LENGTH) {
      const err = new Error(`topic must be ${MAX_TOPIC_LENGTH} characters or fewer.`);
      err.status = 400;
      throw err;
    }
    const gap = await createUserKeywordGap(
      req.params.siteId,
      topic,
      'Requested on the Analyst page as a growth target.'
    );
    // From the Keywords page the choice (blog, landing page or just track) arrives with the keyword.
    const plan = req.body?.plan;
    if (plan !== undefined && !PLANS.includes(plan)) {
      const err = new Error("plan must be 'blog', 'landing' or 'track'.");
      err.status = 400;
      throw err;
    }
    const planned = plan ? await applyGapPlan(req.params.siteId, gap.id, plan) : null;
    res.status(gap.alreadyQueued ? 200 : 201).json(planned ? { ...gap, planned } : gap);
  } catch (e) { next(e); }
});

// ───────── the Keywords page ─────────
//
// Two read routes and two write routes behind the page's three questions: what does the site already rank
// for, what do people search that it has no page for, and which pages rank for what. The numbers are the
// last 28 days of Search Console data the site has (ending at its latest day, not at today, because Google
// reports a few days late); the logic is in agents/lib/keyword-plan.js so it can be tested on its own.
const STATS_WINDOW_DAYS = 28;
const isoDay = (d) => d.toISOString().slice(0, 10);

async function statsWindow(siteId) {
  const { as_of: asOf } = await gscDailyDataAsOf(siteId);
  if (!asOf) return null;
  const end = new Date(`${asOf}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (STATS_WINDOW_DAYS - 1));
  return { start: isoDay(start), end: isoDay(end) };
}
const windowMetrics = async (siteId) => {
  const win = await statsWindow(siteId);
  return { win, metrics: win ? await getQueryPageMetrics(siteId, win.start, win.end, { minImpressions: 1 }) : [] };
};

router.get('/internal/keywords/:siteId/overview', async (req, res, next) => {
  try {
    const siteId = req.params.siteId;
    const [site, { win, metrics }, gaps, capabilities] = await Promise.all([
      getSiteById(siteId), windowMetrics(siteId), getKeywordGaps(siteId),
      getProductCapabilities(siteId, 'verified').catch(() => []),
    ]);
    const isProduct = site?.property_type === 'product';
    res.json({ ...buildKeywordsOverview({ metrics, gaps, capabilities, isProduct }), isProduct, window: win });
  } catch (e) { next(e); }
});

router.get('/internal/keywords/:siteId/pages', async (req, res, next) => {
  try {
    const siteId = req.params.siteId;
    const [{ win, metrics }, inventory, gaps] = await Promise.all([windowMetrics(siteId), listPageInventory(siteId, { limit: 2000 }), getKeywordGaps(siteId)]);
    res.json({ ...buildPagesOverview({ metrics, inventory, gaps }), window: win });
  } catch (e) { next(e); }
});

// What to recommend for a keyword the person has typed, before anything is saved: one small classification
// (what people want when they search it, and whether it matches what the site sells), or "just track" when
// the site already ranks for it. Writes nothing, so cancelling the question leaves no trace.
router.post('/internal/keywords/:siteId/recommend', async (req, res, next) => {
  try {
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    if (!topic) { const err = new Error('topic is required.'); err.status = 400; throw err; }
    if (topic.length > MAX_TOPIC_LENGTH) { const err = new Error(`topic must be ${MAX_TOPIC_LENGTH} characters or fewer.`); err.status = 400; throw err; }

    const { metrics } = await windowMetrics(req.params.siteId);
    const ranked = buildHaveKeywords(metrics).find((h) => h.keyword === normalizeKeyword(topic));
    if (ranked) {
      return res.json({ plan: 'track', reason: 'Your site already ranks for this, so tracking is enough.', intent: null, relevance: null, alreadyRanks: true });
    }
    const classification = await classifyGapRelevance(req.params.siteId, { topic }).catch(() => null);
    const rec = recommendPlanForGap({
      topic, search_intent: classification?.searchIntent ?? null, product_relevance: classification?.productRelevance ?? null,
    });
    res.json({ ...rec, intent: classification?.searchIntent ?? null, relevance: classification?.productRelevance ?? null, alreadyRanks: false });
  } catch (e) { next(e); }
});

// Carries out the person's choice for one keyword. 'track' keeps the keyword and creates nothing; 'blog' and
// 'landing' create exactly one piece of content: a blog is queued for the daily run, a landing page is drafted
// now and waits for the person's approval in Action Center. The gap is marked approved so the weekly
// automatic cycle, which only looks at pending gaps, never writes a second piece for it. A different choice
// for something already planned is refused rather than queuing a second piece of content.
async function applyGapPlan(siteId, gapId, plan) {
  const current = await getGapContentPlan(siteId, gapId);
  if (!current) { const err = new Error('Keyword gap not found.'); err.status = 404; throw err; }
  if (current.content_plan && current.content_plan !== 'track' && current.content_plan !== plan) {
    const err = new Error(`This keyword is already planned as a ${current.content_plan === 'landing' ? 'landing page' : 'blog post'}. Cancel that in Action Center first.`);
    err.status = 409;
    throw err;
  }
  if (current.content_plan === plan && plan !== 'track') return { plan, alreadyPlanned: true, actionCenter: null };

  const updated = await updateKeywordGapStatus(siteId, gapId, 'approved');
  let actionCenter = null;
  if (plan !== 'track') {
    // A blog is safe-tier: queued for the daily run, which drafts it and opens the pull request. A landing page
    // is manual-tier, so the daily run would never pick it up; it is drafted now and waits for approval in
    // Action Center, like any other landing page.
    actionCenter = await createActionCenterRecommendationForGap(siteId, updated, { deferDraft: plan === 'blog', clientRequested: plan === 'blog', plan });
    if (!actionCenter?.eligible) {
      await updateKeywordGapStatus(siteId, gapId, 'pending_review'); // nothing was created, so nothing was decided
      return { plan: null, notCreated: true, actionCenter };
    }
  }
  await setGapContentPlan(siteId, gapId, plan);
  return { plan, actionCenter };
}

router.post('/internal/keywords/:siteId/gaps/:gapId/plan', async (req, res, next) => {
  try {
    const { plan } = req.body || {};
    if (!PLANS.includes(plan)) { const err = new Error("plan must be 'blog', 'landing' or 'track'."); err.status = 400; throw err; }
    res.json(await applyGapPlan(req.params.siteId, req.params.gapId, plan));
  } catch (e) { next(e); }
});

// English glosses for non-English keywords shown on the Analyst page. A POST
// (not a GET) only because the term list can outgrow a query string; it reads
// and writes nothing. Fails soft inside translateKeywords — never a 500 for
// a decorative lookup.
router.post('/internal/keywords/:siteId/translate', async (req, res, next) => {
  try {
    const terms = req.body?.terms;
    if (!Array.isArray(terms)) {
      const err = new Error('terms must be an array of strings.');
      err.status = 400;
      throw err;
    }
    res.json({ translations: await translateKeywords(terms) });
  } catch (e) { next(e); }
});

// status vocabulary here matches getKeywordGaps' own output exactly
// (pending_review/approved/rejected — see GAP_STATUS_FROM_DB in
// server/store/data-analyst.js) so a value read from GET .../gaps can be
// round-tripped straight back through this route with no translation.
router.put('/internal/keywords/:siteId/gaps/:gapId', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      const err = new Error("status must be 'approved' or 'rejected'.");
      err.status = 400;
      throw err;
    }
    const updated = await updateKeywordGapStatus(req.params.siteId, req.params.gapId, status);
    if (!updated) {
      const err = new Error('Keyword gap not found.');
      err.status = 404;
      throw err;
    }

    let actionCenter = null;
    if (status === 'approved') {
      actionCenter = await createActionCenterRecommendationForGap(req.params.siteId, updated);
    }

    res.json({ ...updated, actionCenter });
  } catch (e) { next(e); }
});

// "Write a blog on this keyword?" — the Yes on the Analyst page's Grow for a
// keyword box (web/src/components/AnalystGrowKeyword.jsx), answered right
// after the keyword was added.
//
// Deliberately its own route rather than a flag on the PUT above, because it
// means something different from staff approval even though both end in an
// approved gap: staff approval drafts immediately (someone is waiting to look
// at the result), whereas this queues ONE blog for the next daily run and
// shows nothing now. Keeping them separate also keeps the PUT's contract
// ('approved'/'rejected', round-trippable from GET .../gaps) unchanged.
//
// Idempotent by construction: the gap is matched by id, and
// createActionCenterRecommendationForGap reuses an open recommendation for
// the same topic instead of creating a second one (findOpenRecommendation),
// so a double-click cannot queue two blogs on one keyword.
router.post('/internal/keywords/:siteId/gaps/:gapId/request-blog', async (req, res, next) => {
  try {
    const updated = await updateKeywordGapStatus(req.params.siteId, req.params.gapId, 'approved');
    if (!updated) {
      const err = new Error('Keyword gap not found.');
      err.status = 404;
      throw err;
    }

    const actionCenter = await createActionCenterRecommendationForGap(req.params.siteId, updated, {
      deferDraft: true,
      clientRequested: true,
    });
    res.json({ ...updated, actionCenter });
  } catch (e) { next(e); }
});

router.get('/internal/keywords/:siteId/profile', async (req, res, next) => {
  try {
    res.json(await getSiteProfile(req.params.siteId));
  } catch (e) { next(e); }
});

// Product Understanding Layer (migration 111) — what this site's OWN
// product actually does, kept separate from site_profiles above (which
// profiles topics the site already ranks for, not what it sells). Every
// write here is human-asserted ('verified'/'human') — there is no writer
// yet that lets an agent propose one, so nothing here is ever invented.
router.get('/internal/keywords/:siteId/capabilities', async (req, res, next) => {
  try {
    const { status, kind } = req.query;
    // Defaults to 'capability' so the Analyst page's existing list is exactly
    // what it was before migration 176; `kind=all` returns every kind of
    // product knowledge, or pass one specific kind.
    if (kind !== undefined && kind !== 'all' && !PRODUCT_KNOWLEDGE_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be 'all' or one of ${PRODUCT_KNOWLEDGE_KINDS.join(', ')}.` });
    }
    res.json(await getProductCapabilities(req.params.siteId, status, { kind: kind === 'all' ? null : (kind || 'capability') }));
  } catch (e) { next(e); }
});

router.post('/internal/keywords/:siteId/capabilities', async (req, res, next) => {
  try {
    const { name, category, description, industries, kind, details } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }
    if (kind !== undefined && !PRODUCT_KNOWLEDGE_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${PRODUCT_KNOWLEDGE_KINDS.join(', ')}.` });
    }
    const capability = await createProductCapability(req.params.siteId, {
      name: String(name).trim(),
      category: category || null,
      description: description || null,
      industries: Array.isArray(industries) ? industries : [],
      kind: kind || 'capability',
      details: details && typeof details === 'object' && !Array.isArray(details) ? details : {},
    });
    res.status(201).json(capability);
  } catch (e) { next(e); }
});

router.put('/internal/keywords/:siteId/capabilities/:capabilityId', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['verified', 'proposed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status must be 'verified', 'proposed' or 'rejected'." });
    }
    const updated = await updateProductCapabilityStatus(req.params.siteId, req.params.capabilityId, status);
    if (!updated) {
      const err = new Error('Product capability not found.');
      err.status = 404;
      throw err;
    }
    res.json(updated);
  } catch (e) { next(e); }
});

// Strategic Product Topic Map (product-visibility growth objective, Phase
// 3) — read-time aggregation, see buildProductTopicMap's own doc comment
// for why this isn't a persisted table.
router.get('/internal/keywords/:siteId/topic-map', async (req, res, next) => {
  try {
    res.json(await buildProductTopicMap(req.params.siteId));
  } catch (e) { next(e); }
});

// Supplementary narrative — server/agents/keyword-narrative.js, separate
// from the Python executive-summary pipeline. Returns the latest row or
// null if the 14-day job hasn't run yet for this site.
router.get('/internal/keywords/:siteId/narrative', async (req, res, next) => {
  try {
    res.json(await getLatestKeywordNarrative(req.params.siteId));
  } catch (e) { next(e); }
});

// Section ids the Analyst page renders — see DEFAULT_SECTIONS in
// web/src/pages/Analyst.jsx. Kept here as the server-side source of truth
// for validating Claude's response so a malformed/missing id can never drop
// a section from the frontend's layout.
const LAYOUT_SECTION_IDS = ['hero', 'fixes', 'summary', 'priorities', 'studio', 'workspace', 'diagnostics', 'correlations', 'keyword-discovery'];

const LAYOUT_SYSTEM_PROMPT = `You are a dashboard layout optimizer.
Given the current state of a website's
analytics, decide which sections of the
analyst dashboard are most important to
show first today.

Available sections (use exact ids):
- hero (Prediction Readout)
- fixes (Proactive Fix Board)
- summary (AI Executive Summary)
- priorities (Recommendation Priority)
- studio (Predictive Intelligence Studio)
- workspace (Investigation Workspace)
- diagnostics (Diagnostic Tools)
- correlations (Correlation Explorer)
- keyword-discovery (Keyword Discovery)

Rules:
- If anomalies detected → put fixes first
- If keyword gaps exist → put keyword-discovery
  in top 4
- If forecast errors → put hero + diagnostics first
- Always keep summary in top 3
- Return ALL 9 section ids in priority order

Return only JSON, no other text:
{
  layout: [array of 9 section ids in order],
  reason: one sentence explaining top priority
}`;

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Best-effort JSON extraction — Claude is instructed to return raw JSON, but
// this tolerates an accidental markdown code fence around it.
function parseLayoutResponse(raw) {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* give up below */ } }
  return null;
}

function isValidLayout(layout) {
  return Array.isArray(layout)
    && layout.length === LAYOUT_SECTION_IDS.length
    && new Set(layout).size === LAYOUT_SECTION_IDS.length
    && layout.every((id) => LAYOUT_SECTION_IDS.includes(id));
}

// AI-suggested section order for today — see web/src/pages/Analyst.jsx's
// loadAILayout. Reuses the same site data as the keyword narrative
// (site_profiles, keyword_gaps) plus anomalies/forecast_runs status, and
// caches the result in layout_suggestions so this isn't a fresh Claude call
// on every page load — only when the day changes or the underlying
// anomaly/gap counts actually move.
router.get('/internal/keywords/:siteId/layout', async (req, res, next) => {
  try {
    const siteId = req.params.siteId;
    const [profile, gaps, anomalies, forecastStatuses] = await Promise.all([
      getSiteProfile(siteId),
      getKeywordGaps(siteId, 'pending_review'),
      getAnomalyAlerts(siteId),
      getLatestForecastStatuses(siteId),
    ]);

    const anomalyCount = anomalies.length;
    const gapCount = gaps.length;

    const cached = await getLatestLayoutSuggestion(siteId);
    const generatedToday = cached && new Date(cached.generated_at).toDateString() === new Date().toDateString();
    const cachedSignature = cached?.layout_json?.signature;
    const signatureUnchanged = cachedSignature
      && cachedSignature.anomalyCount === anomalyCount
      && cachedSignature.gapCount === gapCount;

    if (cached && generatedToday && signatureUnchanged && isValidLayout(cached.layout_json.layout)) {
      return res.json({ layout: cached.layout_json.layout, reason: cached.reason, generated_at: cached.generated_at });
    }

    const topGaps = [...gaps].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)).slice(0, 5);
    const recentAnomalies = anomalies.slice(0, 3);
    const forecastIssues = forecastStatuses.some((f) => f.status !== 'ok');

    const facts = {
      industry: profile?.industry ?? null,
      siteType: profile?.site_type ?? null,
      mainTopics: profile?.main_topics ?? null,
      keywordGaps: topGaps.map((g) => ({ topic: g.topic, priority: g.priority })),
      recentAnomalies: recentAnomalies.map((a) => ({ metric: a.metric_key, direction: a.direction, score: a.score, createdAt: a.created_at })),
      forecastIssues,
    };

    let parsed = null;
    try {
      const raw = await callLLM(LAYOUT_SYSTEM_PROMPT, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 300 });
      parsed = parseLayoutResponse(raw);
    } catch (err) {
      console.warn('[keywords] layout suggestion LLM call failed:', err.message);
    }

    const layout = isValidLayout(parsed?.layout) ? parsed.layout : LAYOUT_SECTION_IDS;
    const reason = typeof parsed?.reason === 'string' ? parsed.reason : null;

    const saved = await saveLayoutSuggestion(siteId, { layout, signature: { anomalyCount, gapCount } }, reason);
    res.json({ layout, reason, generated_at: saved.generated_at });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Client-facing mirror — /keywords/... for the logged-in client's OWN site.
//
// Every route above is staff-only and takes the site from the URL
// (:siteId). The Keywords page is for every client, so this mirror re-exposes
// the same handlers (exactly the same code, nothing re-implemented) under
// /keywords/..., with two differences that make it safe for a tenant:
//   - the site is ALWAYS the session's own (req.siteId, set by requireAuth),
//     never anything the URL says — a client cannot name another site;
//   - only the routes the Keywords page uses are exposed (no `layout`, which
//     is a staff-only LLM call).
// requireAuth already refuses writes from read-only workspace members, so
// no write route here has to remember that.
//
// Mounted in server/index.js BEFORE the staff-only block (see the mount-order
// note there): the path-prefixed requireAuth below only ever touches
// /keywords/..., so it cannot interfere with any other router.
// ---------------------------------------------------------------------------
const INTERNAL_PREFIX = '/internal/keywords/:siteId';
const CLIENT_ROUTES = [
  ['get', '/clusters'],
  ['get', '/growth-opportunities'],
  ['post', '/growth-opportunities/generate-draft'],
  ['get', '/overview'],
  ['get', '/pages'],
  ['post', '/recommend'],
  ['post', '/gaps/:gapId/plan'],
  ['get', '/gaps'],
  ['post', '/gaps'],
  ['post', '/translate'],
  ['put', '/gaps/:gapId'],
  ['post', '/gaps/:gapId/request-blog'],
  ['get', '/profile'],
  ['get', '/capabilities'],
  ['post', '/capabilities'],
  ['put', '/capabilities/:capabilityId'],
  ['get', '/topic-map'],
  ['get', '/narrative'],
];

export const clientKeywordsRouter = Router();
clientKeywordsRouter.use('/keywords', requireAuth);
for (const [method, suffix] of CLIENT_ROUTES) {
  const layer = router.stack.find((l) => l.route?.path === INTERNAL_PREFIX + suffix && l.route.methods[method]);
  if (!layer) throw new Error(`keywords client mirror: ${method.toUpperCase()} ${INTERNAL_PREFIX + suffix} is not registered`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  clientKeywordsRouter[method](`/keywords${suffix}`, (req, res, next) => {
    // The one line that makes this tenant-safe: whatever the URL carried, the
    // handler runs against the session's own site.
    req.params.siteId = String(req.siteId);
    return handler(req, res, next);
  });
}

export default router;
