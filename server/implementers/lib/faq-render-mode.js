import { getFileContent } from '../../github/client.js';
import { resolveFile, resolveAdapter } from './url-file-map.js';
import { baseBranch } from './github-ops.js';
import { inspectRenderMode, hasVisibleFaqSignal } from './render-inspector.js';
import { hasImplementedVisibleFaqForPage, distinctVisibleFaqDraftPages } from '../../store/drafts.js';
import { analyzePageUrl } from '../../agents/lib/page-content.js';

// A pagination/data-array route (e.g. /compare/*) has no per-page template
// file of its own — every entry is rendered by ONE shared layout, driven by
// data. Before a FAQ draft can ever be trusted to actually appear on the
// live page, something has to confirm that shared layout genuinely loops
// over the adapter's own itemsField (e.g. "{% for faq in comp.faqs %}") —
// NOT merely that the adapter is configured to WRITE that field (resolveAdapter/
// isPageMapped already confirm that much) and NOT by scanning for FAQ-shaped
// markup the way render-inspector.js's scanVisibleFaqSignals does for a
// normal single-representation file: a shared layout's own literal source
// (including its "@type":"FAQPage" schema block, written directly in the
// template) is present unconditionally regardless of whether any given
// entry's real data currently has FAQs — scanning it with that logic would
// misread every entry as "already has one," visible-content or not. This is
// a narrower, unambiguous question instead: can this template render
// `itemsField` AT ALL, independent of any one entry's current data state.
const NUNJUCKS_LOOP_RE_TEMPLATE = (field) => new RegExp(`\\{%-?\\s*for\\s+\\w+\\s+in\\s+[\\w.]*\\b${field}\\b\\s*-?%\\}`, 'i');
const JSX_MAP_NEAR_FIELD_RE_TEMPLATE = (field) => new RegExp(`\\b${field}\\b[\\s\\S]{0,40}?\\.map\\(`, 'i');

export function templateRendersItemsField(templateSource, itemsField) {
  if (!templateSource || !itemsField) return false;
  const escaped = itemsField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return NUNJUCKS_LOOP_RE_TEMPLATE(escaped).test(templateSource)
    || JSX_MAP_NEAR_FIELD_RE_TEMPLATE(escaped).test(templateSource);
}

// The sitewide visible-FAQ cap must reflect the CURRENT live/repository
// state, not a permanent historical record of pages this tool once pushed a
// visible FAQ to (store/drafts.js's countVisibleFaqDrafts only ever grows —
// it has no way to notice a page's visible FAQ was later removed by a
// manual edit, a revert, or an unrelated redesign). Re-fetches each
// historically-visible page's CURRENT content and only counts it if a
// visible FAQ signal is still actually there today — a page that dropped
// its visible FAQ since frees up a cap slot for a future draft, exactly as
// if the count had never included it. Bounded by the cap itself (a handful
// of pages at most), so a handful of extra live fetches per FAQ draft's
// render-mode decision is cheap.
export async function countCurrentlyVisibleFaqPages(site, { fetchFile = getFileContent, beforeRef = baseBranch(site), listPages = distinctVisibleFaqDraftPages } = {}) {
  const pages = await listPages(site.id);
  let count = 0;
  for (const page of pages) {
    const filePath = resolveFile(site, page);
    if (!filePath) continue; // no longer mapped at all — can't still be live
    const file = await fetchFile(site, filePath, beforeRef);
    if (!file) continue; // file gone — can't still be live
    if (hasVisibleFaqSignal(file.content)) count += 1;
  }
  return count + (site.visible_faq_baseline || 0);
}

// Single source of truth for the visible-vs-schema-only decision on a FAQ
// draft, shared by every writer mechanism this codebase has for FAQ content:
// backend.js's marker-merge HTML splice (which already has the page's
// template file fetched for its own splice and calls decideFaqRenderMode
// directly), and the data-array-content adapter, routed here via
// resolve.js's resolveImplementerForApply BEFORE it even decides which
// writer handles the draft. Same evidence in, same verdict out, regardless
// of which mechanism a given page happens to be configured with.
//
// The one signal render-inspector.js can't see on its own: whether a draft
// using the OTHER mechanism already published a visible FAQ for this exact
// page (store/drafts.js's hasImplementedVisibleFaqForPage) — checked first,
// ahead of any file inspection, since it's stronger evidence than a content
// scan and the two mechanisms' output isn't visible to each other any other
// way (see that function's own comment).
// Shared by decideFaqRenderMode and decideFaqRenderModeForDataDrivenPage
// below — the two strongest, most universal signals, checked identically
// regardless of which mechanism ends up deciding the rest. Returns the
// decision when conclusive, or null when inconclusive (no existing FAQ found
// this way) so each caller can fall through to its own remaining evidence.
async function checkCrossMechanismAndLiveFaq(site, page, { readLivePage = analyzePageUrl } = {}) {
  if (await hasImplementedVisibleFaqForPage(site.id, page)) {
    return {
      mode: 'schema-only', confidence: 95,
      reason: 'This page already has a visible FAQ published by an earlier draft — publishing structured data only to avoid a duplicate.',
      source: 'cross-mechanism',
    };
  }

  // The rendered page, not just its own template file. Every other signal
  // here reads the repo, and a page's visible FAQ frequently does not live in
  // the file that page resolves to — it can come from an included partial, a
  // layout, or a shared data file looped somewhere else entirely. In all
  // those cases hasVisibleFaqSignal scans the page's template, correctly
  // finds nothing, and a second visible FAQ gets published onto a page that
  // already had one. That is the /resources/ duplicate-FAQ shape (a
  // {% for %} over a shared _data file), and no amount of template scanning
  // can rule it out in general.
  //
  // A rule of "never two visible FAQs on a page" has to be checked against
  // what the page actually shows, so this asks the live page directly and
  // forces schema-only when it already has one — whoever authored it, by
  // whatever mechanism, including a hand-built FAQ this tool never touched.
  //
  // Best-effort by design: a failed/blocked fetch falls through to the
  // caller's own remaining logic rather than blocking a legitimate draft. It
  // can only ever move the decision toward schema-only, never toward visible.
  try {
    const live = await readLivePage(page);
    // Same >=2 bar as render-inspector/page-content use for "a real
    // accordion" — one question-shaped heading is not an FAQ section, and
    // treating it as one would wrongly suppress every legitimate first FAQ.
    if (live?.ok && (live.analysis?.faqVisibleQuestionCount || 0) >= 2) {
      return {
        mode: 'schema-only', confidence: 95,
        reason: `The live page already shows a visible FAQ (${live.analysis.faqVisibleQuestionCount} questions) — publishing structured data only, since a page never gets a second visible FAQ.`,
        source: 'live-page',
      };
    }
  } catch { /* fall through */ }
  return null;
}

export async function decideFaqRenderMode(site, page, fileContent, actionType = 'faq', { readLivePage = analyzePageUrl } = {}) {
  const early = await checkCrossMechanismAndLiveFaq(site, page, { readLivePage });
  if (early) return early;
  const visibleFaqCount = await countCurrentlyVisibleFaqPages(site);
  return inspectRenderMode(fileContent, actionType, { visibleFaqCount, visibleFaqCap: site.visible_faq_cap });
}

// For a pagination/data-array page with no per-page template file to scan
// (see templateRendersItemsField above for why the shared layout's own raw
// source can't be scanned the way inspectRenderMode scans a normal file).
// Once the render-inspector.js gate (recommendation-gates.js) has already
// confirmed the shared layout genuinely renders this field, the remaining
// decision — visible vs. schema-only — reduces cleanly to real,
// entry-specific evidence: does this SPECIFIC page already show one
// (checkCrossMechanismAndLiveFaq), and is the sitewide cap still open. No
// structural scan is needed or meaningful here: with no prior draft, the
// live page (checked above) is already definitive.
export async function decideFaqRenderModeForDataDrivenPage(site, page, { readLivePage = analyzePageUrl } = {}) {
  const early = await checkCrossMechanismAndLiveFaq(site, page, { readLivePage });
  if (early) return early;
  const visibleFaqCount = await countCurrentlyVisibleFaqPages(site);
  const cap = site.visible_faq_cap ?? Infinity;
  if (visibleFaqCount >= cap) {
    return {
      mode: 'schema-only', confidence: 90,
      reason: `Sitewide visible-FAQ limit reached (${visibleFaqCount}/${site.visible_faq_cap}) — publishing structured data only to keep visible FAQs selective.`,
      source: 'cap',
    };
  }
  return {
    mode: 'visible', confidence: 90,
    reason: 'No existing visible FAQ detected on this page, and the sitewide visible-FAQ cap is not exhausted — safe to add a visible FAQ block.',
    source: 'deterministic',
  };
}

// Full version for a caller that doesn't have the page's template file
// fetched yet (resolve.js — it needs the mode BEFORE it knows whether to
// route to the adapter or the default implementer, so it has nothing fetched
// at all going in). Resolves the same real file backend.js's own
// computeMarkerMerge would use (lib/url-file-map.js's resolveFile), so
// resolve.js's routing decision reflects the exact same live evidence
// backend.js would see if it ended up handling this draft directly.
export async function resolveFaqRenderMode(site, draft, { fetchFile = getFileContent, beforeRef = baseBranch(site) } = {}) {
  const page = draft.content?.page || draft.input?.page;
  const filePath = resolveFile(site, page);
  if (!filePath) {
    // A pagination/data-array route (e.g. /compare/*) has no per-page file —
    // recommendation-gates.js has already confirmed (before this draft could
    // even exist) that the adapter's own templateFile genuinely renders
    // itemsField, so the remaining decision is real, entry-specific evidence
    // only (see decideFaqRenderModeForDataDrivenPage's own comment).
    const adapterConfig = resolveAdapter(site, page, 'faq');
    if (adapterConfig?.id === 'data-array-content' && adapterConfig?.itemsField) {
      return decideFaqRenderModeForDataDrivenPage(site, page);
    }
    // No real template configured for this page at all — there's nothing to
    // scan for an organic pre-existing FAQ. Honest uncertainty (the same
    // confidence-0 "ask a human" outcome as a genuine infra failure below)
    // rather than a silent visible guess: a wrong guess here publishes
    // unwanted content to real visitors, a materially worse outcome than
    // asking once.
    return {
      mode: null, confidence: 0,
      reason: `No "file" configured for "${page}" in url_file_map — cannot check for an existing FAQ before deciding whether to publish a new visible one.`,
      source: 'no-template',
    };
  }
  const file = await fetchFile(site, filePath, beforeRef);
  if (!file) {
    return { mode: null, confidence: 0, reason: `${filePath} does not exist on branch "${beforeRef}".`, source: 'error' };
  }
  return decideFaqRenderMode(site, page, file.content);
}
