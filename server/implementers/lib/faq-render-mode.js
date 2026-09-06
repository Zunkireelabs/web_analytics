import { getFileContent } from '../../github/client.js';
import { resolveFile } from './url-file-map.js';
import { baseBranch } from './github-ops.js';
import { inspectRenderMode, hasVisibleFaqSignal } from './render-inspector.js';
import { hasImplementedVisibleFaqForPage, distinctVisibleFaqDraftPages } from '../../store/drafts.js';
import { analyzePageUrl } from '../../agents/lib/page-content.js';

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
export async function decideFaqRenderMode(site, page, fileContent, actionType = 'faq', { readLivePage = analyzePageUrl } = {}) {
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
  // existing repo-based logic rather than blocking a legitimate draft. It can
  // only ever move the decision toward schema-only, never toward visible.
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
  } catch { /* fall through to the repo-based decision below */ }

  const visibleFaqCount = await countCurrentlyVisibleFaqPages(site);
  return inspectRenderMode(fileContent, actionType, { visibleFaqCount, visibleFaqCap: site.visible_faq_cap });
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
