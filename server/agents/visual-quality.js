import { launchBrowser, capturePage } from '../design-agent/live-analysis/capture.js';
import { classifyPageType } from '../design-agent/live-analysis/schema.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { analyzePageUrl, effortForGenerator } from './lib/page-content.js';
import { makeFinding, priorityByRank, impactFromPriority } from './lib/findings.js';
import { findOpenRecommendation, insertRecommendation } from '../store/recommendations.js';
import { recommendationPageKey } from './lib/recommendation-coordinator.js';
import { callLLMWithImages, extractJson } from '../llm.js';

// Expensive, narrow tier of the cost-conscious detection strategy —
// content-integrity.js is the cheap-wide tier this layers on top of.
// Screenshots + one multi-image vision call are real cost, so this stays
// small; what changed (2026-09-01) is HOW the small batch is chosen.
//
// Before this, the page set came from capture.js's discoverPages(): the
// homepage plus the first same-origin link found for each OTHER page type,
// re-crawled fresh every run. That crawl is deterministic — the homepage's
// own link order doesn't change run to run — so this agent had been vision-
// auditing the exact same ~8 pages every single day since it was built.
// Every other page on the site had NEVER been visually checked, no matter
// how many days passed. Confirmed live: identical `checkedPages` across
// separate runs.
//
// Now uses the SAME rotation ledger (agent_page_rotation via
// selectCandidatePages/markPagesChecked) content-integrity.js and every
// other page-level agent already share, under its own 'visual-quality'
// agentId so its rotation position is independent of theirs. This is what
// "cheap-wide, expensive-narrow" actually means in practice: the expensive
// tier still only touches a handful of pages per run, but those pages
// rotate — least-recently-checked and GSC-traffic-weighted, the same real
// prioritization signal every other candidate-driven agent already trusts —
// so the whole site is eventually covered instead of a frozen sample.
const VISUAL_BATCH_SIZE = 8;

// The real per-URL capture (launchBrowser + capturePage, both already used
// elsewhere) applied to an EXPLICIT candidate list, instead of capture.js's
// captureSite/discoverPages doing its own blind same-origin link crawl.
// classifyPageType stands in for discoverPages' page-type tagging — the
// prompt's summarizeBlocksForPrompt reads page.pageType, and URL-shape
// classification is the same heuristic discoverPages itself used.
async function capturePagesFor(urls, { screenshots = true, launchBrowserFn = launchBrowser } = {}) {
  if (!urls.length) return { pages: [] };
  const browser = await launchBrowserFn();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const browserPage = await context.newPage();
    const pages = [];
    for (const url of urls) {
      // eslint-disable-next-line no-await-in-loop
      const captured = await capturePage(browserPage, url, { screenshot: screenshots }).catch((err) => {
        console.warn(`[visual-quality] could not capture ${url}: ${err.message}`);
        return null;
      });
      if (captured) pages.push({ ...captured, pageType: classifyPageType(url) });
    }
    return { pages };
  } finally {
    await browser.close();
  }
}

// run()'s injectable `capture` seam, default implementation: select this
// run's rotation-position candidates, screenshot them, then advance the
// rotation — the three steps a real run needs, bundled so run() itself stays
// a plain "capture -> judge -> ship" pipeline with no rotation bookkeeping of
// its own. A site with no candidate pages (no domain configured, or nothing
// in page_inventory/GSC yet) returns no pages, same as before this rotation
// existed — run() already treats "no screenshots" as insufficient-data.
export async function defaultCapture(siteId, {
  start, end, screenshots = true, batchSize = VISUAL_BATCH_SIZE,
  selectCandidates = selectCandidatePages, capturePages = capturePagesFor, mark = markPagesChecked,
} = {}) {
  const { batch } = await selectCandidates(siteId, 'visual-quality', { start, end, batchSize });
  if (!batch.length) return { pages: [] };
  const { pages } = await capturePages(batch, { screenshots });
  await mark(siteId, 'visual-quality', batch);
  return { pages };
}

// Visual Quality Agent — the missing "does an EXISTING page actually look
// right" check. Every other content-integrity check (font-consistency.js,
// technical-seo.js) either compares computed styles across pages or reads
// static HTML; nothing in this codebase looks at a real rendered screenshot
// and judges whether what a visitor sees is actually broken. This is the
// first caller of llm.js's callLLMWithImages — the first multi-modal call
// in this codebase.
//
// Deliberately scoped to the four defect shapes generators/content-
// integrity-repair.js already knows how to safely fix or safely refuse
// (malformed-table, raw-text-table, faq-schema-mismatch, duplicate-faq) —
// NOT an open-ended "does this look ugly" judge. Vision's job is only to
// spot WHERE one of these four specific, already-real-and-fixable shapes
// might be present, grounded in the real screenshot/DOM evidence given (the
// exact same "never invent, only describe what's given" discipline every
// other generator in this codebase already follows) — never to invent a new
// kind of fix or act as an unrestricted redesign agent. What actually
// SHIPS is decided by a second, fully deterministic layer (see below), not
// by trusting the vision call's own say-so.
//
// A page can have more than one independent defect (a broken table AND a
// duplicate FAQ are unrelated regions), so this processes ALL of them, not
// just the first — recommendationPageKey (recommendation-coordinator.js)
// now includes fixType for this generatorId, so each distinct defect gets
// its own recommendation row rather than colliding into one. Multiple
// recommendations for the same page never mean multiple competing PRs: the
// existing daily auto-remediation run batches every safe-tier recommendation
// it ships that day — across every page, not just this one — into a SINGLE
// branch/PR (github-ops.js's beginBatchPush/finalizeBatchPr), unchanged by
// anything here. "Re-captured/revalidated before shipping" is likewise the
// existing content-integrity-repair contract, not a new mechanism: each
// fixType's own generate() call re-fetches and re-confirms its OWN specific
// condition immediately before drafting, and content-integrity-inject.js's
// apply step only ever writes when the exact anchor text is still found
// byte-for-byte in the page's current real source (which, within one batch,
// already reflects any earlier fix on the same page — anchor matching is a
// full-text search, not a line offset, so it's correct regardless of
// ordering). A second full-page re-screenshot after each fix would be a
// parallel validation system duplicating a safety net that already exists
// and is already trusted by every other content-integrity-repair caller.
export const meta = {
  id: 'visual-quality',
  name: 'Visual Quality Agent',
  description: 'Real headless-browser screenshots of a page-type-diverse sample of the site\'s own live pages, judged by a vision-capable Claude call for four known, already-fixable defect shapes (broken/empty tables, raw-text comparison content, stale FAQ schema, duplicate FAQ sections) — confirmed defects ship autonomously through the existing content-integrity-repair pipeline; unconfirmed ones surface as a manual Action Center review, never silently.',
  category: 'content',
  version: 1,
  dataSources: [
    { id: 'live-browser-capture', status: 'connected', description: 'Playwright headless capture of the site\'s own real rendered pages, including a real screenshot per page — same plumbing as the Design Agent\'s live-site capture, with screenshots opted in.' },
  ],
};

// The only four fixTypes content-integrity-repair.js knows how to apply —
// vision is asked to choose ONLY from this closed set, and anything else it
// returns is discarded as ungrounded rather than trusted (see VISION_SYSTEM).
const KNOWN_FIXTYPES = new Set(['malformed-table', 'raw-text-table', 'faq-schema-mismatch', 'duplicate-faq']);

// Second, deterministic layer: independently confirms a vision-flagged
// defectType against the SAME real static-analysis facts content-integrity-
// repair.js itself will re-check at apply time (page-content.js's
// analyzePageUrl) — vision alone is never trusted to decide what ships.
// This is what keeps "manual" the exception: most of what vision correctly
// spots among these four narrow shapes IS independently confirmable here,
// since they're objective structural facts (empty table rows, a raw-text
// block that parses cleanly into a table, etc.), not aesthetic judgment.
const FIXTYPE_CONFIRMERS = {
  'malformed-table': (a) => (a.removableMalformedTables || []).length > 0,
  'raw-text-table': (a) => (a.rawTextTableBlocks || []).some((b) => b.clean),
  'faq-schema-mismatch': (a) => !!(a.faqSchemaRaw && a.faqSchemaSimple && a.faqExtractionComplete),
  'duplicate-faq': (a) => !!a.duplicateFaqRemovalHtml,
};

// How BIG the confirmed defect actually is, read from the exact same real
// analysis facts the confirmer above just checked — a count of genuinely
// defective regions on the page, never a guess. This is the run's only real
// numeric signal about a visual defect (there is no traffic/score dimension
// on a screenshot), and it is what `priority` and `expectedImpact.value` are
// derived from below. Before this, every confirmed defect was hardcoded
// priority 'high' with expectedImpact {label:'Medium', basis:'computed',
// value:1} — a literal constant claiming a computed basis, which types.js
// forbids for both fields (priority "computed per agent from a real signal
// already in facts — never a fixed constant"; basis 'computed' = "derived
// directly from this run's real numbers"). A page with six broken tables and
// a page with one now rank differently, and the number a reader is shown is
// the real count they can go and verify on the page.
const FIXTYPE_EXTENT = {
  'malformed-table': (a) => (a.removableMalformedTables || []).length,
  'raw-text-table': (a) => (a.rawTextTableBlocks || []).filter((b) => b.clean).length,
  // Real count of visible FAQ entries the page's FAQPage schema doesn't
  // account for. When the two counts happen to match but the schema is still
  // stale, the single out-of-sync schema block is itself the one defective
  // region — hence the floor of 1, never 0 for a confirmed defect.
  'faq-schema-mismatch': (a) => Math.abs((a.faqVisibleQuestionCount || 0) - (a.faqMainEntityCount || 0)) || 1,
  // page-content.js sets duplicateFaqRemovalHtml to the html of exactly ONE
  // confirmed-duplicate container (and only when the overlap is confident),
  // so a confirmed duplicate-faq is precisely one defective region.
  'duplicate-faq': () => 1,
};

const VISION_SYSTEM = 'You are a web QA specialist reviewing real screenshots of live pages from one website. You are ' +
  'given one screenshot per page, each labeled with its real URL, alongside real DOM/CSS facts extracted from that ' +
  'same page load. You may ONLY flag a defect that is one of these four specific shapes, and ONLY when you can ' +
  'actually see clear visual evidence of it in the screenshot itself:\n' +
  '- "malformed-table": a table that renders visibly broken, empty, or with missing/collapsed rows.\n' +
  '- "raw-text-table": comparison-style content (e.g. a feature/plan comparison) shown as plain unstyled text or a ' +
  'bulleted list instead of a real table, when a real table is clearly the intended presentation.\n' +
  '- "faq-schema-mismatch": an FAQ/accordion section whose visible content plainly looks incomplete, mismatched, or ' +
  'stale relative to what a well-formed FAQ should show.\n' +
  '- "duplicate-faq": two visibly near-identical FAQ sections on the same page.\n' +
  'Never invent a defect you cannot actually see. Never flag a page or issue not given to you. Never propose a fix — ' +
  'only report what is visibly wrong and where. Respond with ONLY a JSON array: ' +
  '[{"page": "<exact URL from the list given>", "fixType": "malformed-table"|"raw-text-table"|"faq-schema-mismatch"|"duplicate-faq", ' +
  '"description": "<one plain sentence describing what you actually see>"}]. Return [] if nothing qualifies.';

function summarizeBlocksForPrompt(page) {
  return {
    url: page.url, pageType: page.pageType, title: page.title,
    blocks: (page.blocks || []).map((b) => ({
      tag: b.tag, headingText: b.headingText, bodyText: b.bodyText,
      accordionLike: b.accordionLike, width: b.width, viewportWidth: b.viewportWidth,
    })),
  };
}

export async function run({ siteId, start, end, capture = defaultCapture, analyzePage = analyzePageUrl }) {
  // Same "propagate to runner.js's own try/catch" discipline as font-
  // consistency.js — a live-capture failure is a real infrastructure error,
  // not a customer-facing string to hand-build here. Covers both "nothing to
  // capture" cases in one message now: no candidate pages at all (no domain
  // configured, or nothing in page_inventory/GSC yet — selectCandidatePages'
  // own concern) and every real navigation failing, since both end the same
  // way — no screenshot to show a reviewer or a vision call.
  const { pages } = await capture(siteId, { start, end, screenshots: true });
  const withScreenshots = (pages || []).filter((p) => p.screenshot);
  if (!withScreenshots.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No real page screenshots were available for this site — either no candidate pages yet, or every navigation failed.',
      generatedAt: new Date().toISOString(),
    };
  }

  const byUrl = new Map(withScreenshots.map((p) => [p.url, p]));
  const user = `Pages (in the same order as the attached screenshots):\n` +
    withScreenshots.map((p, i) => `Screenshot ${i + 1}: ${JSON.stringify(summarizeBlocksForPrompt(p))}`).join('\n\n');

  let raw;
  try {
    raw = await callLLMWithImages(VISION_SYSTEM, user, withScreenshots.map((p) => p.screenshot), {
      tier: 'monthly', maxTokens: 1500, generatorId: meta.id, siteId,
    });
  } catch (e) {
    console.warn(`[visual-quality] vision call failed for site ${siteId}: ${e.message}`);
    raw = null;
  }

  const parsed = raw ? extractJson(raw) : null;
  const candidates = Array.isArray(parsed) ? parsed : [];

  // Grounding gate: only a real page from THIS run's own capture, and only
  // one of the four known fixTypes, is ever trusted — anything else the
  // model returned (a hallucinated URL, a made-up fixType) is silently
  // discarded here, never reaches a page load or a recommendation.
  const grounded = candidates.filter((c) => c && byUrl.has(c.page) && KNOWN_FIXTYPES.has(c.fixType) && typeof c.description === 'string');

  // Every distinct real defect this run flagged gets processed — a page can
  // legitimately have more than one independent issue (a malformed table AND
  // a duplicate FAQ are unrelated regions of the same page). Only exact
  // (page, fixType) repeats collapse to one, via recommendationPageKey below
  // (recommendation-coordinator.js), which now carries fixType specifically
  // so two distinct defects on the same page never collide into one row and
  // silently lose one of them (same class of bug analytics-install/expand-
  // content/broken-link-fix/blog-outline were each fixed for previously).
  const seenKeys = new Set();
  const deduped = grounded.filter((c) => {
    const key = recommendationPageKey({ generatorId: 'content-integrity-repair', params: { page: c.page, fixType: c.fixType } });
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  // Pass 1 — run the deterministic re-confirmation for every candidate and,
  // for the confirmed ones, measure the defect's real extent (FIXTYPE_EXTENT
  // above) from the same analysis. Split into its own pass because priority
  // is a RELATIVE rank across this run's confirmed defects (priorityByRank,
  // the shared convention every other agent uses) — it can't be assigned
  // while still walking the candidates one at a time.
  const assessed = [];
  for (const candidate of deduped) {
    const { page, fixType } = candidate;
    // eslint-disable-next-line no-await-in-loop
    const analysis = await analyzePage(page).catch(() => null);
    const confirmed = !!(analysis?.ok && FIXTYPE_CONFIRMERS[fixType]?.(analysis.analysis));
    assessed.push({
      ...candidate,
      confirmed,
      extent: confirmed ? (FIXTYPE_EXTENT[fixType]?.(analysis.analysis) || 1) : 0,
    });
  }

  const recommendedActionFor = (params) => ({
    label: `Fix ${params.fixType.replace(/-/g, ' ')}`,
    generatorId: 'content-integrity-repair',
    params,
    effort: effortForGenerator('content-integrity-repair'),
  });

  // Worst-first by the real number of confirmed defective regions, so
  // priorityByRank buckets on a genuine signal from this run's own facts.
  const confirmedDefects = assessed.filter((a) => a.confirmed).sort((a, b) => b.extent - a.extent);
  const confirmedPriorities = priorityByRank(confirmedDefects);
  // Standard grounded-finding shape (facts.findings) — the existing
  // detection -> recommendation -> auto-remediation -> batch-PR pipeline
  // picks this up exactly like every other safe-tier generator's findings,
  // with zero new plumbing: content-integrity-repair is already 'safe'-tier
  // (risk-tiers.js), and its own generate() function independently
  // re-verifies the exact same real condition at apply time (re-fetching the
  // page, refusing if the anchor/condition no longer holds) — the
  // "re-captured/revalidated before shipping" requirement is satisfied by
  // that existing safety net, not by anything new here.
  const findings = confirmedDefects.map(({ page, fixType, description, extent }, i) => {
    const priority = confirmedPriorities[i];
    return makeFinding({
      id: `visual-quality:${fixType}:${page}`,
      // The real, deterministically re-confirmed count of defective regions
      // is part of the evidence, not just a ranking input — it's the number
      // expectedImpact.basis 'computed' is pointing at, and a reader can
      // count the same broken tables on the page themselves.
      evidence: { page, fixType, description, confirmed: true, defectiveRegions: extent },
      whyItMatters: description,
      priority,
      recommendedAction: recommendedActionFor({ page, fixType }),
      expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: extent },
    });
  });

  // Pass 2 — everything vision saw that the deterministic check could NOT
  // independently confirm.
  let manualCreated = 0;
  for (const { page, fixType, description } of assessed.filter((a) => !a.confirmed)) {
    const params = { page, fixType };
    // Vision saw something, but the same deterministic check
    // content-integrity-repair itself relies on could not independently
    // confirm it — never silently dropped (unlike font-consistency's own
    // recommendedAction:null findings, which the standard grounded
    // pipeline filters out with no trace in Action Center): this is the
    // one place this agent writes directly to `recommendations`, at
    // riskTier 'manual', same established precedent as keyword_gaps'
    // 'comparison-page' pseudo-type (analyst-seo-mapping.js) — a real,
    // already-used pattern for "flagged, no confirmed safe autofix, human
    // decides." Clicking Generate on it still runs the real generator,
    // which will honestly refuse if this truly isn't fixable, or
    // succeed if this pre-check was a false negative.
    // Keyed the SAME way the standard grounded pipeline would key this
    // exact (generatorId, params) pair (recommendationPageKey, now with
    // fixType — see recommendation-coordinator.js) — the confirmed and
    // unconfirmed paths must never be able to collide with or shadow each
    // other for the same page, and two distinct unconfirmed fixTypes on
    // the same page must each get their own row too.
    const recKey = recommendationPageKey({ generatorId: 'content-integrity-repair', params });
    // eslint-disable-next-line no-await-in-loop
    const existing = await findOpenRecommendation(siteId, recKey, 'content-integrity-repair');
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await insertRecommendation(siteId, {
        page: recKey,
        recommendationType: 'content-integrity-repair',
        issue: `Possible ${fixType.replace(/-/g, ' ')} on this page`,
        reason: `${description} Flagged by the visual-quality vision pass, but the deterministic content-integrity ` +
          `check could not independently confirm a fixable ${fixType} condition on this page — needs human review ` +
          'before this can safely auto-apply.',
        params,
        findingId: `visual-quality:${fixType}:${page}`,
        detectingAgent: meta.id,
        // Deliberately below every confirmed defect's priority band: the
        // only real signal this row carries is that the deterministic
        // check DISAGREED with vision, so it must never sort above a
        // defect that was independently confirmed and measured.
        priority: 'low',
        riskTier: 'manual',
        blockedReason: 'Unconfirmed by deterministic content-integrity check — vision-flagged only.',
      });
      manualCreated++;
    }
  }

  const facts = {
    checkedPages: withScreenshots.map((p) => p.url),
    candidatesFlagged: deduped.length,
    confirmedAutonomous: findings.length,
    manualReview: manualCreated,
    findings,
  };

  const narrative = deduped.length
    ? `Checked ${withScreenshots.length} real page(s); vision flagged ${deduped.length} possible defect(s), ` +
      `${findings.length} confirmed safe to auto-fix and ${manualCreated} left for manual review.`
    : `Checked ${withScreenshots.length} real page(s); no visual defects of the known, fixable shapes were flagged.`;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
