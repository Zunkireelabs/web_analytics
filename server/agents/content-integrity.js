import pLimit from 'p-limit';
import { getSearchPerformanceForPages } from '../store/read.js';
import { makeFinding, aggregateSystemicFinding } from './lib/findings.js';
import { analyzePageUrl, effortForGenerator, inferSchemaType } from './lib/page-content.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { callLLM } from '../llm.js';

// Detects real, already-live markup breakage that no other agent checks for:
// broken/empty <table> markup (including a genuine colspan/rowspan-aware
// column-count mismatch, not just a naive tag count), comparison content
// shipped as raw text instead of a real table, FAQ content that has drifted
// out of sync with itself (schema question count vs. real visible question
// count, or two separate visible FAQ sections on one page), and the same FAQ
// question answered differently across different pages in this run's batch.
// Every finding is reported for visibility regardless, but recommendedAction
// (generators/content-integrity-repair.js) is only attached when the
// representative page's own detected facts prove the fix is safe to
// auto-apply — a table defect that's a confirmed empty shell/row (never a
// column-mismatch, which has no safe removal fix); a clean, rectangular
// raw-text table; an FAQPage schema block not mixed with other structured
// data plus a fully-extractable set of real visible answers; two FAQ
// sections with substantial (>=80%) real question-text overlap — see
// pickSafeOrTopImpression below; a page whose FAQ topically doesn't match its
// own page, and the same FAQ question answered inconsistently across pages,
// get the same evidence-gated treatment via findTopicallyMismatchedFaq and
// decideCrossPageFaqAnswer respectively. A page whose defect doesn't meet the
// relevant safety bar still shows up in the finding (n of m checked pages),
// just without a one-click fix.
export const meta = {
  id: 'content-integrity',
  name: 'Content Integrity Agent',
  description: 'Checks already-live pages for broken/empty/misaligned table markup, comparison content shipped as raw text instead of a real table, FAQ content out of sync with its own schema or duplicated on a page, the same FAQ question answered inconsistently across different pages, and FAQ content that doesn\'t topically match the page it\'s on.',
  category: 'content',
  version: 1,
};

// Cheap-wide half of the cost-conscious detection strategy: every check
// below is one static fetch + cheerio parse per page (page-content.js's
// analyzePageUrl), with a single LLM call per RUN (not per page — the
// narrative summary at the bottom of run()), so raising this is nearly
// free. Was 20, which meant a full sweep of a several-dozen-page blog
// inventory took many days via selectCandidatePages' rotation — the
// confirmed root cause of "lots of blog posts still have broken tables"
// (2026-09-01 audit): the detector existed and was correctly wired into
// cron, it just could not reach most of the site in any reasonable time.
// This is the cheap tier; visual-quality.js is the expensive, narrower
// tier layered on top of it.
const MAX_PAGES = 100;

// 100 pages scanned per run is NOT the same thing as 100 simultaneous
// requests to one tenant's host — that's real, sudden traffic a client's
// server/WAF has no reason to expect and every reason to flag. Bounded to a
// small number of concurrent in-flight fetches at a time (same p-limit
// convention agents/lib/bulk-audit.js already uses for exactly this
// reasoning), configurable per-deployment since "polite" depends on the
// target host, not on this platform. Read inside run() (call time), not as
// a module-level constant — an env var is meant to be observable per call,
// not frozen at first import.
function fetchConcurrency() {
  return Number(process.env.CONTENT_INTEGRITY_FETCH_CONCURRENCY) || 10;
}

// Prefers a representative that's actually safe to auto-fix (so
// recommendedAction has something real to act on), falling back to the
// highest-impression affected page when none qualify — that page still
// anchors whyItMatters' evidence, it just won't get a recommendedAction.
function pickSafeOrTopImpression(affected, isSafe) {
  const byImpressionsDesc = [...affected].sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  return byImpressionsDesc.find((r) => isSafe(r.analysis)) || byImpressionsDesc[0];
}

// Cross-page FAQ consistency: the same real question text (normalized)
// appearing on 2+ of this run's checked pages with a DIFFERENT real answer —
// a common shape when a sitewide FAQ block (e.g. a shared shipping/returns
// component) drifts on one page after an edit that didn't propagate
// everywhere else it's reused. Detection here is purely structural (which
// question/answer pairs disagree, and where) — deciding WHICH page's answer
// is authoritative is a separate, evidence-based step (see
// decideCrossPageFaqAnswer below), not something this function itself
// attempts. Only ever compares pages actually present in `reachable` — a real, useful
// signal that grows in coverage as the page rotation (selectCandidatePages)
// cycles through the site over time, not a full sitewide guarantee on any
// single run. Exported as a pure function (input: [{page, analysis}]) so it
// can be tested without a live fetch/DB, same convention as country-
// intelligence.js's topGainerAboveThreshold.
export function findInconsistentFaqQuestions(reachable) {
  const questionAnswers = new Map(); // normalized question -> normalized answer -> {answer, pages[]}
  for (const r of reachable) {
    for (const item of r.analysis.faqVisibleItems || []) {
      if (!item.answer) continue;
      const q = item.question.toLowerCase().replace(/\s+/g, ' ').trim();
      const ansNorm = item.answer.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!questionAnswers.has(q)) questionAnswers.set(q, new Map());
      const variants = questionAnswers.get(q);
      if (!variants.has(ansNorm)) variants.set(ansNorm, { answer: item.answer, pages: [] });
      variants.get(ansNorm).pages.push(r.page);
    }
  }
  return [...questionAnswers.entries()]
    .filter(([, variants]) => variants.size >= 2)
    .map(([question, variants]) => ({ question, variants: [...variants.values()] }));
}

// A lighter-weight, purpose-built decision for "which page's FAQ answer is
// right" — NOT duplicate-content.js's decideWinner (lib/duplicate-evidence.js).
// That machinery answers a structurally different question ("which of these
// URLs is the SAME page, via traffic/query-overlap/canonical evidence") —
// nothing there speaks to which of two DIFFERENT pages' TEXT is accurate.
// This only ever runs for a genuine two-way split (variants.length === 2); a
// 3+-way disagreement has no cheap, evidence-based tiebreak and is left for
// a human. Evidence consulted, strongest first, exactly like duplicate-
// evidence.js's own resolveWithAdditionalSignals: try the strongest signal,
// fall through, and only return null (genuinely ambiguous, stays reportOnly)
// once every signal has been tried and none resolved it.
//
//   1. Cross-check against findTopicallyMismatchedFaq's OWN independent
//      finding: if one side's page(s) were already confirmed (by a separate
//      self-consistency-checked LLM pass) to have an FAQ that doesn't even
//      match THEIR OWN page's topic, that side's answer is untrustworthy
//      regardless of its content — the other side wins.
//   2. Real freshness signal (page-content.js's hasFreshnessSignal) — when
//      exactly one side carries it and the other doesn't, the side with a
//      real freshness signal is preferred as more likely current.
//   3. Real, non-overlapping inferred/declared page purpose (inferSchemaType)
//      between the two sides — a signal the pages genuinely serve different
//      audiences/contexts, so BOTH answers can legitimately be correct for
//      their own page. Decided as a real non-issue ('leave-both-independent-
//      intent'), not silently left open — same "decide, don't just punt"
//      standard duplicate-evidence.js's resolveWithAdditionalSignals holds
//      itself to for the structurally similar split-traffic case.
export function decideCrossPageFaqAnswer(entry, { topicMismatchedPages, reachableByPage }) {
  const { variants } = entry;
  if (variants.length !== 2) return null;
  const [v0, v1] = variants;

  const flagged = (pages) => pages.some((p) => topicMismatchedPages.has(p));
  const v0Flagged = flagged(v0.pages);
  const v1Flagged = flagged(v1.pages);
  if (v0Flagged !== v1Flagged) {
    const [winner, loser] = v0Flagged ? [v1, v0] : [v0, v1];
    return {
      decision: 'consolidate', correctAnswer: winner.answer, pagesToFix: loser.pages,
      reason: 'One page\'s FAQ was independently confirmed to not even match its own page\'s topic — its answer here is untrustworthy.',
    };
  }

  const allFresh = (pages) => pages.length > 0 && pages.every((p) => reachableByPage.get(p)?.analysis?.hasFreshnessSignal);
  const v0Fresh = allFresh(v0.pages);
  const v1Fresh = allFresh(v1.pages);
  if (v0Fresh !== v1Fresh) {
    const [winner, loser] = v0Fresh ? [v0, v1] : [v1, v0];
    return {
      decision: 'consolidate', correctAnswer: winner.answer, pagesToFix: loser.pages,
      reason: 'One page carries a real freshness signal the other does not — its answer is preferred as more likely current.',
    };
  }

  const purposesFor = (pages) => new Set(pages.map((p) => {
    const r = reachableByPage.get(p);
    return r ? inferSchemaType(p, r.analysis.schemaTypes, r.analysis) : null;
  }).filter(Boolean));
  const p0 = purposesFor(v0.pages);
  const p1 = purposesFor(v1.pages);
  if (p0.size && p1.size && ![...p0].some((t) => p1.has(t))) {
    return {
      decision: 'leave-both-independent-intent',
      reason: 'These pages carry genuinely different declared/inferred purposes — the same question plausibly has a different, legitimately correct answer on each.',
    };
  }

  return null;
}

// Real incident (zunkireelabs.com/careers/, 2026-09-11): a live FAQ block
// asked "What is Zunkiree Search?" / "What is Agentic as a Service (GaaS)?"
// — product questions — on the careers page. No draft row existed for it
// (this app's own generators never wrote it), so every OTHER check in this
// file is structurally blind to it: the FAQ was internally consistent
// (schema matched visible count, no duplication) — just wrong for the page
// it was on. Catching that needs real topical judgment, not a structural
// comparison, so this is the one check here scoped to a single extra LLM
// call per run (not per page — same cost discipline as the narrative call
// below, still O(1) calls per run) covering every reachable page that has
// FAQ content. Same "verify, don't trust" discipline as nextjs-metadata-
// export.js's ask/extract split: the model's answer is never trusted on
// its own — only `page` values that were actually present in the input are
// ever accepted back, so a hallucinated URL can't produce a finding for a
// page that was never checked. A confirmed match gets a real recommendedAction
// (run() below) whenever content-integrity-repair.js's own safety bar is met
// — the fix regenerates the FAQ using the exact same real-evidence-grounded
// generation generators/faq.js already uses for a net-new FAQ (page body
// text, real title, PAGE_PURPOSE_GUIDANCE), never invented content — and
// falls back to reportOnly, not needsHuman, when that bar isn't met.
const FAQ_TOPIC_SYSTEM_PROMPT = 'You check whether a page\'s visible FAQ questions actually relate to that page\'s own topic '
  + '(given by its <title>). Given a JSON array of {page, title, questions}, return ONLY a JSON array of the '
  + '"page" values (exact strings copied from the input, nothing else) whose FAQ questions are clearly about a '
  + 'DIFFERENT topic than the page\'s own title — e.g. product-feature FAQs on a careers/about/contact page. A '
  + 'page whose FAQ is even a loose, reasonable match to its title must NOT be included. If none are mismatched, '
  + 'return [].';

// One independent LLM pass — page values are validated against `candidates`
// so a hallucinated URL can never produce a flag for a page that was never
// checked. Never throws: a failure or malformed response is an empty set,
// not a crash, same fail-closed posture as the rest of this file.
async function singleFaqTopicPass(candidates, askLLM) {
  let raw;
  try {
    raw = await askLLM(FAQ_TOPIC_SYSTEM_PROMPT, JSON.stringify(candidates), { maxTokens: 300 });
  } catch (err) {
    console.warn('[agents] content-integrity FAQ-relevance check failed:', err.message);
    return new Set();
  }
  let flagged;
  try { flagged = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || '[]'); } catch { return new Set(); }
  if (!Array.isArray(flagged)) return new Set();
  const validPages = new Set(candidates.map((c) => c.page));
  return new Set(flagged.filter((p) => validPages.has(p)));
}

// A single LLM pass on a "does this look wrong" judgment call is exactly
// the kind of question that varies run to run — this endpoint has no
// explicit temperature pinned to 0, so two independent asks of the same
// input are genuinely two independent samples, not wasted duplicate work.
// Self-consistency (ask twice, keep only the intersection) is a real,
// established way to raise precision on a judgment call that has no
// deterministic ground truth to check against — it can't make either
// individual pass smarter, but it does mean a one-off inconsistent flag
// (the model agreeing with itself by chance, not because the page is
// actually wrong) gets filtered out before it ever reaches a human — or an
// automatic fix — as a finding. Since a confirmed match can now carry a real
// recommendedAction (run() below), the cost of a false positive here is no
// longer just a human's wasted look; it's worth trading some recall for.
export async function findTopicallyMismatchedFaq(reachable, askLLM = callLLM) {
  const candidates = reachable
    .filter((r) => (r.analysis.faqVisibleItems || []).length >= 2)
    .map((r) => ({ page: r.page, title: r.analysis.title || '', questions: (r.analysis.faqVisibleItems || []).slice(0, 6).map((i) => i.question) }));
  if (!candidates.length) return [];

  const [first, second] = await Promise.all([
    singleFaqTopicPass(candidates, askLLM),
    singleFaqTopicPass(candidates, askLLM),
  ]);
  return candidates.filter((c) => first.has(c.page) && second.has(c.page));
}

export async function run({ siteId, start, end, pageCache, params }) {
  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    : await selectCandidatePages(siteId, 'content-integrity', { start, end, batchSize: MAX_PAGES });

  if (!batch.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No page performance data yet to select pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const fetchPage = pageCache || analyzePageUrl;
  const limit = pLimit(fetchConcurrency());
  const fetched = await Promise.all(batch.map((page) => limit(async () => ({ page, result: await fetchPage(page) }))));
  if (!params?.pages?.length) await markPagesChecked(siteId, 'content-integrity', batch);

  const reachable = fetched.filter((r) => r.result.ok).map((r) => ({ page: r.page, analysis: r.result.analysis, impressions: impressionsByPage.get(r.page) || 0 }));

  const brokenTableFinding = aggregateSystemicFinding({
    id: 'content-integrity:broken-table',
    affected: reachable.filter((r) => r.analysis.malformedTableCount > 0),
    checkedCount: reachable.length,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `${n} of ${c} checked pages have a <table> that's empty, has a row with no cells, or has a row whose real (colspan/rowspan-aware) column count doesn't match the rest of the table — visitors see a broken/misaligned table where consistent data should be.`,
    extraEvidence: (affected) => ({ samples: affected.slice(0, 5).map((r) => ({ page: r.page, issues: r.analysis.malformedTables })) }),
    // Only 'no-rows'/'empty-row' (removableMalformedTables) have a safe
    // automatic fix — a genuinely misaligned data row ('column-mismatch')
    // stays visible here but never gets an auto-remove action, since
    // removing real (if misaligned) data isn't a repair.
    pickRepresentative: (affected) => pickSafeOrTopImpression(affected, (a) => (a.removableMalformedTables || []).length > 0),
    recommendedAction: (representative) => {
      const target = (representative.analysis.removableMalformedTables || [])[0];
      if (!target) return null;
      return {
        label: 'Remove broken table markup',
        generatorId: 'content-integrity-repair',
        params: { page: representative.page, fixType: 'malformed-table' },
        effort: effortForGenerator('content-integrity-repair'),
      };
    },
  });

  const rawTextTableFinding = aggregateSystemicFinding({
    id: 'content-integrity:raw-text-table',
    affected: reachable.filter((r) => r.analysis.rawTextTableCount > 0),
    checkedCount: reachable.length,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `${n} of ${c} checked pages have comparison/tabular content shipped as raw delimited text instead of a real <table> — it renders as an unformatted wall of text instead of readable rows and columns.`,
    extraEvidence: (affected) => ({ samples: affected.slice(0, 5).map((r) => ({ page: r.page, blocks: r.analysis.rawTextTableBlocks })) }),
    pickRepresentative: (affected) => pickSafeOrTopImpression(affected, (a) => (a.rawTextTableBlocks || []).some((b) => b.clean)),
    recommendedAction: (representative) => {
      if (!(representative.analysis.rawTextTableBlocks || []).some((b) => b.clean)) return null;
      return {
        label: 'Rebuild raw-text table as real markup',
        generatorId: 'content-integrity-repair',
        params: { page: representative.page, fixType: 'raw-text-table' },
        effort: effortForGenerator('content-integrity-repair'),
      };
    },
  });

  const faqMismatchFinding = aggregateSystemicFinding({
    id: 'content-integrity:faq-schema-mismatch',
    affected: reachable.filter((r) => r.analysis.faqCountMismatch),
    checkedCount: reachable.length,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `${n} of ${c} checked pages have an FAQPage schema whose question count doesn't match the real number of visible FAQ questions on the page — the structured data no longer describes what a visitor actually sees.`,
    extraEvidence: (affected) => ({ samples: affected.slice(0, 5).map((r) => ({ page: r.page, schemaCount: r.analysis.faqMainEntityCount, visibleCount: r.analysis.faqVisibleQuestionCount })) }),
    pickRepresentative: (affected) => pickSafeOrTopImpression(affected, (a) => a.faqSchemaSimple && a.faqExtractionComplete),
    recommendedAction: (representative) => {
      const a = representative.analysis;
      if (!a.faqSchemaSimple || !a.faqExtractionComplete) return null;
      return {
        label: 'Resync FAQ schema with visible content',
        generatorId: 'content-integrity-repair',
        params: { page: representative.page, fixType: 'faq-schema-mismatch' },
        effort: effortForGenerator('content-integrity-repair'),
      };
    },
  });

  // Deliberately NOT folded into faq-schema-mismatch above: that finding is
  // "the schema drifted from the page" and its repair resyncs one against the
  // other. This is "the schema describes content that does not exist," which
  // is a Google FAQ rich-result policy violation rather than a drift, and has
  // no honest automatic fix — resyncing to zero visible questions would mean
  // deleting the schema, while writing the missing FAQ is a content decision.
  // So it reports and leaves the call to a human, same as every other finding
  // here whose only fixes would require inventing content.
  const faqSchemaWithoutVisibleFinding = aggregateSystemicFinding({
    id: 'content-integrity:faq-schema-without-visible',
    affected: reachable.filter((r) => r.analysis.faqSchemaWithoutVisible),
    checkedCount: reachable.length,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `${n} of ${c} checked pages carry FAQPage structured data but show no FAQ content at all. Google requires FAQ markup to describe content visible on the page — schema with nothing behind it risks a manual action or loss of rich results, and tells AI crawlers the page answers questions a visitor can't actually find.`,
    extraEvidence: (affected) => ({ samples: affected.slice(0, 5).map((r) => ({ page: r.page, schemaCount: r.analysis.faqMainEntityCount, visibleCount: 0 })) }),
    recommendedAction: null,
  });

  const duplicateFaqFinding = aggregateSystemicFinding({
    id: 'content-integrity:duplicate-visible-faq',
    affected: reachable.filter((r) => r.analysis.duplicateVisibleFaqSections),
    checkedCount: reachable.length,
    getPage: (r) => r.page,
    getImpressions: (r) => r.impressions,
    whyItMatters: (n, c) => `${n} of ${c} checked pages render two or more separate FAQ sections — a page is only ever meant to show one visible FAQ block.`,
    // Only offered when detection found substantial real question-text
    // overlap between two sections (duplicateFaqRemovalHtml set) — a page
    // with two legitimately different FAQ sections (e.g. shipping + returns)
    // stays visible here but never gets an auto-remove action.
    pickRepresentative: (affected) => pickSafeOrTopImpression(affected, (a) => !!a.duplicateFaqRemovalHtml),
    recommendedAction: (representative) => {
      if (!representative.analysis.duplicateFaqRemovalHtml) return null;
      return {
        label: 'Remove duplicate FAQ section',
        generatorId: 'content-integrity-repair',
        params: { page: representative.page, fixType: 'duplicate-faq' },
        effort: effortForGenerator('content-integrity-repair'),
      };
    },
  });

  const reachableByPage = new Map(reachable.map((r) => [r.page, r]));

  // Computed BEFORE the cross-page finding below — decideCrossPageFaqAnswer's
  // strongest signal reuses this finding's own result (a page already
  // confirmed off-topic for itself is untrustworthy evidence for a
  // cross-page disagreement too), never a second, separate topic check.
  const topicMismatchedFaq = await findTopicallyMismatchedFaq(reachable);
  const topicMismatchedPages = new Set(topicMismatchedFaq.map((c) => c.page));

  // Per the platform's DISCOVER->FIX policy: a topic-mismatched page's FAQ
  // gets a real recommendedAction whenever content-integrity-repair.js's own
  // safety bar is met (every visible answer confidently extracted, and one
  // single unambiguous FAQ container to rewrite in place) — the same
  // "narrow, evidence-gated auto-fix, else stays informational" discipline
  // every other finding in this file already follows. Picks the
  // highest-impression eligible page as the one draftable example, same
  // convention as pickSafeOrTopImpression above (this finding isn't built via
  // aggregateSystemicFinding, since its evidence comes from an LLM pass, not
  // a structural per-page fact, so the representative pick is done inline
  // here instead).
  const topicMismatchEligible = topicMismatchedFaq
    .map((c) => reachableByPage.get(c.page))
    .filter((r) => r && r.analysis.faqExtractionComplete && r.analysis.faqContainerHtml)
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  const topicMismatchRepresentative = topicMismatchEligible[0] || null;
  const faqTopicMismatchFinding = topicMismatchedFaq.length ? makeFinding({
    id: 'content-integrity:faq-topic-mismatch',
    evidence: { affectedCount: topicMismatchedFaq.length, checkedCount: reachable.length, samples: topicMismatchedFaq.slice(0, 5).map((c) => ({ page: c.page, title: c.title, questions: c.questions })) },
    whyItMatters: `${topicMismatchedFaq.length} of ${reachable.length} checked page(s) show a visible FAQ whose questions don't match the page's own topic (e.g. product FAQs on a careers/about page) — likely leftover or copy-pasted content, not something this app's own generators produced.`,
    priority: 'medium',
    recommendedAction: topicMismatchRepresentative ? {
      label: 'Rewrite this page\'s FAQ to match its own topic',
      generatorId: 'content-integrity-repair',
      params: { page: topicMismatchRepresentative.page, fixType: 'faq-topic-mismatch' },
      effort: effortForGenerator('content-integrity-repair'),
    } : null,
    expectedImpact: { label: 'Medium', basis: 'estimate', value: topicMismatchedFaq.length },
  }) : null;

  const inconsistentFaqQuestions = findInconsistentFaqQuestions(reachable);
  let faqCrossPageFinding = null;
  if (inconsistentFaqQuestions.length) {
    const resolutions = inconsistentFaqQuestions.map((entry) => decideCrossPageFaqAnswer(entry, { topicMismatchedPages, reachableByPage }));
    const decidedCount = resolutions.filter(Boolean).length;
    // First confidently-resolved AND auto-fixable entry becomes this
    // finding's one draftable action — a genuinely decided-but-unfixable
    // entry (the losing page fails content-integrity-repair's own safety
    // bar) still counts toward decidedCount/whyItMatters, it just doesn't
    // supply the action, same "informational but decided" outcome every
    // other narrow auto-fix in this file already allows.
    let recommendedAction = null;
    for (let i = 0; i < inconsistentFaqQuestions.length && !recommendedAction; i++) {
      const resolved = resolutions[i];
      if (resolved?.decision !== 'consolidate') continue;
      const target = resolved.pagesToFix
        .map((p) => reachableByPage.get(p))
        .find((r) => r && r.analysis.faqExtractionComplete && r.analysis.faqContainerHtml);
      if (!target) continue;
      recommendedAction = {
        label: 'Correct this page\'s FAQ answer to match its more authoritative page',
        generatorId: 'content-integrity-repair',
        params: {
          page: target.page, fixType: 'faq-cross-page-inconsistency',
          question: inconsistentFaqQuestions[i].question, correctAnswer: resolved.correctAnswer,
        },
        effort: effortForGenerator('content-integrity-repair'),
      };
    }
    faqCrossPageFinding = makeFinding({
      id: 'content-integrity:faq-cross-page-inconsistency',
      evidence: {
        affectedCount: inconsistentFaqQuestions.length, checkedCount: reachable.length,
        samples: inconsistentFaqQuestions.slice(0, 5), decidedCount,
      },
      whyItMatters: `${inconsistentFaqQuestions.length} FAQ question(s) appear on more than one checked page with a different real answer each time — visitors get inconsistent information depending which page they land on.`
        + (decidedCount ? ` ${decidedCount} of these were resolved from real evidence (an independently-confirmed off-topic FAQ, a freshness signal, or a genuinely different declared page purpose).` : ''),
      priority: 'medium',
      recommendedAction,
      expectedImpact: { label: 'Medium', basis: 'computed', value: inconsistentFaqQuestions.length },
    });
  }

  const findings = [brokenTableFinding, rawTextTableFinding, faqMismatchFinding, faqSchemaWithoutVisibleFinding, duplicateFaqFinding, faqCrossPageFinding, faqTopicMismatchFinding].filter(Boolean);

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    checkedPages: batch,
    pagesChecked: reachable.length,
    findings,
  };

  const system = 'You are a content quality specialist writing for a non-technical site owner. Given real, ' +
    'statically-verified issues (broken/empty tables, comparison content shipped as raw text instead of a real ' +
    'table, FAQ content out of sync with its own schema or duplicated on a page), write 2-3 sentences naming the ' +
    'single most important real issue and one concrete next step. Use ONLY the data given, never invent a page or ' +
    'number not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] content-integrity narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
