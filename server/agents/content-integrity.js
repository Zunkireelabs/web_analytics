import { getSearchPerformanceForPages } from '../store/read.js';
import { makeFinding, aggregateSystemicFinding } from './lib/findings.js';
import { analyzePageUrl, effortForGenerator } from './lib/page-content.js';
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
// pickSafeOrTopImpression below. A page whose defect doesn't meet that bar
// still shows up in the finding (n of m checked pages), just without a
// one-click fix. Cross-page FAQ inconsistency has no automatic fix at all
// (nothing here knows which page's answer is authoritative) and is always
// manual-only.
export const meta = {
  id: 'content-integrity',
  name: 'Content Integrity Agent',
  description: 'Checks already-live pages for broken/empty/misaligned table markup, comparison content shipped as raw text instead of a real table, FAQ content out of sync with its own schema or duplicated on a page, and the same FAQ question answered inconsistently across different pages.',
  category: 'content',
  version: 1,
};

const MAX_PAGES = 20;

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
// everywhere else it's reused. Unlike the within-page checks in run() below,
// there is no safe automatic fix here: nothing in this app knows which
// page's answer is the current/authoritative one, so this is always a
// manual-only finding (no recommendedAction — see run()'s use of this). Only
// ever compares pages actually present in `reachable` — a real, useful
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
  const fetched = await Promise.all(batch.map(async (page) => ({ page, result: await fetchPage(page) })));
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

  const inconsistentFaqQuestions = findInconsistentFaqQuestions(reachable);
  const faqCrossPageFinding = inconsistentFaqQuestions.length ? makeFinding({
    id: 'content-integrity:faq-cross-page-inconsistency',
    evidence: { affectedCount: inconsistentFaqQuestions.length, checkedCount: reachable.length, samples: inconsistentFaqQuestions.slice(0, 5) },
    whyItMatters: `${inconsistentFaqQuestions.length} FAQ question(s) appear on more than one checked page with a different real answer each time — visitors get inconsistent information depending which page they land on.`,
    priority: 'medium',
    recommendedAction: null,
    expectedImpact: { label: 'Medium', basis: 'computed', value: inconsistentFaqQuestions.length },
  }) : null;

  const findings = [brokenTableFinding, rawTextTableFinding, faqMismatchFinding, duplicateFaqFinding, faqCrossPageFinding].filter(Boolean);

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
