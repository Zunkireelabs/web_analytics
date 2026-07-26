import { resolveFile, resolveSiteRootFile, resolveMarkers } from './lib/url-file-map.js';
import { pushDraftBranch, openPrForBranch, getOrInitBatchBranch, baseBranch } from './lib/github-ops.js';
import { getFileContent, searchCodeForString } from '../github/client.js';
import { buildMergeValues, spliceMarkers, getMarkerContent, ensureMarkers, isHeadScopedField } from './lib/marker-merge.js';
import { spliceHashBlock, validateNginxBraces, getHashMarkerContent } from './lib/hash-marker-merge.js';
import { injectHtmlLang, getHtmlTag } from './lib/html-lang-inject.js';
import { setViewportMeta, getViewportMeta } from './lib/viewport-inject.js';
import { rewriteHref, stripLink, getAnchorsForHref } from './lib/href-rewrite-inject.js';
import { inspectRenderMode, CONFIDENCE_THRESHOLD, INSPECTABLE_ACTION_TYPES } from './lib/render-inspector.js';
import { countVisibleFaqDrafts } from '../store/drafts.js';

export const meta = {
  id: 'backend',
  name: 'Backend/SEO Implementer',
  description: 'Applies machine-readable draft content (schema markup, meta tags, FAQ schema, internal links, llms.txt/robots.txt, security headers, html lang) as a real pull request.',
  handles: ['schema', 'meta-title', 'faq', 'internal-links', 'llms-txt', 'security-headers', 'html-lang', 'viewport', 'robots-fix', 'redirect-fix', 'broken-link-fix', 'canonical', 'open-graph', 'expand-content'],
};

// Every backend.js type with a real merge strategy — see lib/marker-merge.js
// for why (a literal splice between human-placed marker comments, the one
// merge approach that never requires parsing an unknown site's real
// templating syntax). schema is a single self-contained JSON-LD block, same
// shape as faq's; internal-links renders its suggestion list to a
// deterministic <ul> first (see marker-merge.js's renderLinksHtml) — neither
// needs a different mechanism, just its own marker name and value-builder.
const MARKER_MERGE_TYPES = new Set(['meta-title', 'faq', 'schema', 'internal-links', 'canonical', 'open-graph', 'expand-content']);

// The real field name buildMergeValues() (lib/marker-merge.js) expects for
// each action type — used only to build an accurate, type-specific example
// in the "no markers configured" error below, never hardcoded to one type
// regardless of which draft actually triggered it.
const MARKER_FIELD_BY_ACTION_TYPE = {
  'meta-title': 'title',
  faq: 'faq',
  schema: 'schema',
  'internal-links': 'links',
  canonical: 'canonical',
  'open-graph': 'openGraph',
  'expand-content': 'expandedContent',
};

function markerConfigExample(actionType) {
  const field = MARKER_FIELD_BY_ACTION_TYPE[actionType] || 'field';
  return { field, marker: field.toUpperCase() };
}

// llms-txt is site-level, not per-page — draft.content.llmsTxt/robotsDirectives
// are already full raw file-body strings (server/generators/llms-txt.js), so
// this is a straight file write with zero content transformation needed. The
// only unknown is *where* those files live in this site's repo, which
// site.url_file_map.siteRoot answers explicitly.
async function pushLlmsTxtBranch(site, draft, batchInfo) {
  const llmsPath = resolveSiteRootFile(site, 'llmsTxt');
  if (!llmsPath) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.llmsTxt is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const files = [{ path: llmsPath, content: draft.content.llmsTxt }];

  const robotsPath = resolveSiteRootFile(site, 'robotsTxt');
  if (robotsPath && draft.content.robotsDirectives) {
    files.push({ path: robotsPath, content: draft.content.robotsDirectives });
  }
  return pushDraftBranch(site, draft, files, batchInfo);
}

// Real, hash-comment-marker splice for the nginx security-headers block —
// nginx doesn't understand `<!-- -->`, so this can't reuse marker-merge.js's
// BLOCK convention. No auto-insert of a missing marker (see
// hash-marker-merge.js) and a string-level brace-balance guardrail
// (validateNginxBraces) before this ever returns ok, since there's no way to
// run a real `nginx -t` here (pure REST writes, no clone, no nginx binary).
// Shared by preview() and apply(), same "can never diverge" discipline as
// computeMarkerMerge.
async function computeSecurityHeadersMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const spliced = spliceHashBlock(file.content, 'SECURITY-HEADERS', draft.content.nginxBlock);
  if (!spliced.ok) return spliced;
  const validated = validateNginxBraces(spliced.newContent);
  if (!validated.ok) return validated;
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: spliced.newContent,
    changedRegions: [{ field: 'nginxBlock', markerName: 'SECURITY-HEADERS', before: spliced.changedRegion.before, after: spliced.changedRegion.after }],
  };
}

async function pushSecurityHeadersBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeSecurityHeadersMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveSecurityHeaders(site, draft) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  const content = getHashMarkerContent(file.content, 'SECURITY-HEADERS');
  if (content === null) {
    return { ok: false, reason: 'no-insertion-marker', error: `No SEOAI:SECURITY-HEADERS marker found in ${path} — it may have been removed or overwritten since this draft was implemented.` };
  }
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'nginxBlock', markerName: 'SECURITY-HEADERS', content }] };
}

// Real, hash-comment-marker splice for a robots.txt Allow-override — third
// dedicated hash-marker special case alongside security-headers, reusing
// the same hash-marker-merge.js (robots.txt uses `#` comments, same as
// nginx) and the same site-root robotsTxt key llms-txt already uses.
// Deliberately NOT the llms-txt full-overwrite path: that path already
// carries acknowledged full-overwrite risk for this exact file, and
// extending it here would let a future llms-txt draft silently clobber
// this bounded marker region. No brace-balance check (robots.txt has no
// braces) — spliceHashBlock's own single-marker-uniqueness check is the
// guardrail.
async function computeRobotsFixMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'robotsTxt');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.robotsTxt is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const spliced = spliceHashBlock(file.content, 'ROBOTS-FIX', draft.content.robotsBlock);
  if (!spliced.ok) return spliced;
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: spliced.newContent,
    changedRegions: [{ field: 'robotsBlock', markerName: 'ROBOTS-FIX', before: spliced.changedRegion.before, after: spliced.changedRegion.after }],
  };
}

async function pushRobotsFixBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeRobotsFixMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveRobotsFix(site, draft) {
  const path = resolveSiteRootFile(site, 'robotsTxt');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.robotsTxt is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  const content = getHashMarkerContent(file.content, 'ROBOTS-FIX');
  if (content === null) {
    return { ok: false, reason: 'no-insertion-marker', error: `No SEOAI:ROBOTS-FIX marker found in ${path} — it may have been removed or overwritten since this draft was implemented.` };
  }
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'robotsBlock', markerName: 'ROBOTS-FIX', content }] };
}

// Direct attribute injection for the shared layout's <html> tag — no marker
// convention needed (see html-lang-inject.js). `lang-already-present` is
// remapped to a benign `already-applied` (nothing to do, not an error the
// reviewer needs to act on); `no-html-tag` means the wrong file is mapped,
// same shape as any other `no-file-mapping` failure.
async function computeHtmlLangMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'layoutTemplate');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.layoutTemplate is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const injected = injectHtmlLang(file.content, draft.content.lang);
  if (!injected.ok) {
    if (injected.reason === 'lang-already-present') return { ok: false, reason: 'already-applied', error: injected.error };
    if (injected.reason === 'no-html-tag') return { ok: false, reason: 'no-file-mapping', error: injected.error };
    return injected;
  }
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: injected.newContent,
    changedRegions: [{ field: 'lang', before: injected.changedRegion.before, after: injected.changedRegion.after }],
  };
}

async function pushHtmlLangBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeHtmlLangMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveHtmlLang(site, draft) {
  const path = resolveSiteRootFile(site, 'layoutTemplate');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.layoutTemplate is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  const tag = getHtmlTag(file.content);
  if (tag === null) {
    return { ok: false, reason: 'no-insertion-marker', error: `No <html> tag found in ${path} — it may have moved since this draft was implemented.` };
  }
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'lang', content: tag }] };
}

// Direct insert-or-replace for the shared layout's <meta name="viewport">
// tag — no marker convention needed (see viewport-inject.js). Unlike
// html-lang, this also handles the "present but wrong" case by replacing
// the whole content attribute, not just inserting when absent.
// `viewport-already-correct` is remapped to a benign `already-applied`;
// `no-head-tag` means the wrong file is mapped, same shape as `no-file-mapping`.
async function computeViewportMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'layoutTemplate');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.layoutTemplate is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const set = setViewportMeta(file.content, draft.content.viewportContent);
  if (!set.ok) {
    if (set.reason === 'viewport-already-correct') return { ok: false, reason: 'already-applied', error: set.error };
    if (set.reason === 'no-head-tag') return { ok: false, reason: 'no-file-mapping', error: set.error };
    return set;
  }
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: set.newContent,
    changedRegions: [{ field: 'viewportContent', before: set.changedRegion.before, after: set.changedRegion.after }],
  };
}

async function pushViewportBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeViewportMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveViewport(site, draft) {
  const path = resolveSiteRootFile(site, 'layoutTemplate');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.layoutTemplate is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  const tag = getViewportMeta(file.content);
  if (tag === null) {
    return { ok: false, reason: 'no-insertion-marker', error: `No <meta name="viewport"> tag found in ${path} — it may have moved since this draft was implemented.` };
  }
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'viewportContent', content: tag }] };
}

// Targeted anchor rewrite/removal for a specific href on a specific page —
// per-page like the marker-merge types below (resolveFile, not
// resolveSiteRootFile), but not marker-based: there's no bounded region an
// arbitrary <a> tag lives in, so this searches the whole file for an exact
// href match instead (see href-rewrite-inject.js). `no-match` is an honest
// failure (link already fixed/removed since detection, or lives in a
// shared partial outside this page's own template file) — never guessed.
async function computeRedirectFixMerge(site, draft, beforeRef) {
  const filePath = resolveFile(site, draft.content.page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${draft.content.page}" — add one via \`npm run connect-repo\` before this can be applied.` };
  }
  const file = await getFileContent(site, filePath, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const rewritten = rewriteHref(file.content, draft.content.oldHref, draft.content.newHref);
  if (!rewritten.ok) return rewritten;
  return {
    ok: true, filePath, oldContent: file.content, newContent: rewritten.newContent,
    changedRegions: [{ field: 'href', before: draft.content.oldHref, after: draft.content.newHref }],
  };
}

async function pushRedirectFixBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeRedirectFixMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveRedirectFix(site, draft) {
  const filePath = resolveFile(site, draft.content.page);
  if (!filePath) return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${draft.content.page}".` };
  const file = await getFileContent(site, filePath, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${baseBranch(site)}".` };
  const anchors = getAnchorsForHref(file.content, draft.content.newHref);
  if (!anchors.length) {
    return { ok: false, reason: 'no-insertion-marker', error: `No <a href="${draft.content.newHref}"> found in ${filePath} — it may have changed since this draft was implemented.` };
  }
  return { ok: true, filePath, live: true, changedRegions: anchors.map((content) => ({ field: 'href', content })) };
}

const CODE_SEARCH_MAX_CANDIDATES = 5; // small N — bounds worst-case calls on the rate-limited search fallback

// One readable sentence summarizing every attempt across both layers, for
// the single `error` string surfaced to a human — full per-attempt detail
// still lives in `attempted` for anyone (UI, logs, MCP) that wants it.
function summarizeBrokenLinkAttempts(sourcePages, href, attempted) {
  const sourceAttempts = attempted.filter((a) => a.matchedVia === 'source-page');
  const noMapping = sourceAttempts.filter((a) => a.reason === 'no-file-mapping').length;
  const noAnchor = sourceAttempts.length - noMapping;
  const searchAttempts = attempted.filter((a) => a.matchedVia === 'code-search');
  const searchError = searchAttempts.find((a) => a.reason === 'code-search-error');

  const sourceSummary = `${sourcePages.length} known source page(s) (${noMapping} have no url_file_map entry; ${noAnchor} mapped file(s) don't contain this link)`;
  const searchSummary = searchError
    ? `code search fallback failed: ${searchError.error}`
    : searchAttempts.length
      ? `also checked ${searchAttempts.length} GitHub code-search candidate(s), none matched`
      : 'code search fallback found no candidates';

  return `No file could be found or safely stripped for href="${href}" across ${sourceSummary} — ${searchSummary}.`;
}

async function computeBrokenLinkFixMerge(site, draft, beforeRef) {
  const href = draft.content.href;
  // Back-compat: a draft persisted before this change has no sourcePages
  // key at all — fall back to the single `page` field, same effective
  // behavior as today for those drafts.
  const sourcePages = [...new Set(
    Array.isArray(draft.content.sourcePages) && draft.content.sourcePages.length
      ? draft.content.sourcePages
      : [draft.content.page].filter(Boolean)
  )];

  const files = [];
  const attempted = [];
  const seenPaths = new Set();

  // Layer 1: every known source page's mapped file, not just the first —
  // and every one that genuinely matches, not just the first success. The
  // same dead href is often hardcoded on more than one page's own file.
  for (const page of sourcePages) {
    const filePath = resolveFile(site, page);
    if (!filePath) { attempted.push({ page, matchedVia: 'source-page', reason: 'no-file-mapping' }); continue; }
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);

    const file = await getFileContent(site, filePath, beforeRef);
    if (!file) { attempted.push({ page, filePath, matchedVia: 'source-page', reason: 'file-not-found' }); continue; }

    const stripped = stripLink(file.content, href);
    if (!stripped.ok) { attempted.push({ page, filePath, matchedVia: 'source-page', reason: stripped.reason, error: stripped.error }); continue; }

    files.push({
      filePath, oldContent: file.content, newContent: stripped.newContent,
      changedRegions: [{ field: 'href', before: href, after: null }],
      matchedVia: 'source-page', matchedFrom: page,
    });
  }

  if (files.length) return { ok: true, files, attempted };

  // Layer 2: only when Layer 1 found ZERO matches anywhere — last resort,
  // never speculative. GitHub's code search has its own, stricter rate
  // limit than the Contents API, so a failure here degrades to "no
  // candidates" rather than failing the whole preview/apply.
  let candidates = [];
  try {
    candidates = await searchCodeForString(site, href, { maxResults: CODE_SEARCH_MAX_CANDIDATES });
  } catch (err) {
    attempted.push({ matchedVia: 'code-search', reason: 'code-search-error', error: err.message });
  }

  for (const filePath of candidates) {
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    const file = await getFileContent(site, filePath, beforeRef);
    if (!file) { attempted.push({ filePath, matchedVia: 'code-search', reason: 'file-not-found' }); continue; }
    const stripped = stripLink(file.content, href);
    if (!stripped.ok) { attempted.push({ filePath, matchedVia: 'code-search', reason: stripped.reason, error: stripped.error }); continue; }
    files.push({
      filePath, oldContent: file.content, newContent: stripped.newContent,
      changedRegions: [{ field: 'href', before: href, after: null }],
      matchedVia: 'code-search',
    });
  }

  if (files.length) return { ok: true, files, attempted };

  return {
    ok: false,
    reason: attempted.length && attempted.every((a) => a.reason === 'no-file-mapping') ? 'no-file-mapping' : 'no-match',
    error: summarizeBrokenLinkAttempts(sourcePages, href, attempted),
    attempted,
  };
}

async function pushBrokenLinkFixBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeBrokenLinkFixMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  const pushed = await pushDraftBranch(
    site, draft,
    merged.files.map((f) => ({ path: f.filePath, content: f.newContent })),
    batchInfo,
  );
  if (!pushed.ok) return pushed;
  return {
    ...pushed,
    appliedFiles: merged.files.map((f) => ({ filePath: f.filePath, matchedVia: f.matchedVia, matchedFrom: f.matchedFrom || null })),
  };
}

async function previewLiveBrokenLinkFix(site, draft) {
  const href = draft.content.href;
  // A draft implemented before this change has no appliedFiles recorded —
  // fall back to today's single-file re-resolution for those.
  const appliedFiles = draft.content.appliedFiles;
  const filePaths = appliedFiles?.length
    ? appliedFiles.map((f) => f.filePath)
    : [resolveFile(site, draft.content.page)].filter(Boolean);

  if (!filePaths.length) return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${draft.content.page}".` };

  const files = [];
  for (const filePath of filePaths) {
    const file = await getFileContent(site, filePath, baseBranch(site));
    // Implemented means the anchor was already stripped — its live absence
    // (getAnchorsForHref finds none left) IS the confirmation, not a failure.
    const anchors = file ? getAnchorsForHref(file.content, href) : [];
    files.push({
      filePath,
      changedRegions: [{ field: 'href', content: file ? (anchors.length ? anchors.join('\n') : '(link removed)') : '(file not found)' }],
    });
  }
  return { ok: true, live: true, files };
}

// Real, marker-based merge for meta-title/faq (see lib/marker-merge.js) —
// shared by preview() (stops here, no GitHub write) and apply() below, so a
// reviewer's preview and the real PR's diff can never diverge; they're
// always the output of this exact same function.
//
// Render mode is no longer static config — it's decided fresh here, every
// call, by inspecting the actual live file (lib/render-inspector.js,
// deterministic-first, LLM only when genuinely ambiguous). `renderModeOverride`
// is the one way a human's already-confirmed choice re-enters this — passed
// through from routes/action-center.js after a prior 'render-mode-uncertain'
// stop, never persisted as site config.
async function computeMarkerMerge(site, draft, renderModeOverride, beforeRef = baseBranch(site)) {
  const page = draft.content?.page || draft.input?.page;
  const filePath = resolveFile(site, page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
  }

  const markerMap = resolveMarkers(site, page, draft.action_type);
  if (!markerMap) {
    const { field, marker } = markerConfigExample(draft.action_type);
    return {
      ok: false, reason: 'no-insertion-marker',
      error: `No markers configured for "${page}" in url_file_map.pages[...].placements or .markers — add e.g. {"${field}":"${marker}"} there, and a matching marker in ${filePath}: either <!-- SEOAI:${marker}:START -->...<!-- SEOAI:${marker}:END --> around HTML content, or a trailing # SEOAI:${marker} comment on a single quoted-value line (e.g. front matter).`,
    };
  }

  const branch = beforeRef;
  const file = await getFileContent(site, filePath, branch);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${branch}" — confirm the path in url_file_map is correct.` };
  }

  let mode, inspection;
  if (renderModeOverride) {
    mode = renderModeOverride;
  } else {
    let inspectionOpts = {};
    if (INSPECTABLE_ACTION_TYPES.includes(draft.action_type)) {
      inspectionOpts = { visibleFaqCount: await countVisibleFaqDrafts(site.id), visibleFaqCap: site.visible_faq_cap };
    }
    inspection = await inspectRenderMode(file.content, draft.action_type, inspectionOpts);
    if (!inspection.mode || inspection.confidence < CONFIDENCE_THRESHOLD) {
      return {
        ok: false, reason: 'render-mode-uncertain', error: inspection.reason,
        confidence: inspection.confidence, suggestedMode: inspection.mode,
      };
    }
    mode = inspection.mode;
  }

  const built = buildMergeValues(draft.action_type, draft.content, mode);
  if (!built.ok) return { ok: false, reason: 'draft-not-ready', error: built.error };

  // Auto-creates any marker in markerMap that isn't already in the live
  // file — see lib/marker-merge.js's ensureMarkers for the two placement
  // strategies. `oldContent` below stays the true original fetch, so the
  // diff a reviewer sees includes the marker's own creation alongside the
  // content splice, not just the content — nothing here skips review, it
  // only removes the separate manual "push an empty marker first" step
  // that used to have to happen before a draft could even reach preview.
  const ensured = ensureMarkers(file.content, markerMap);

  const spliced = spliceMarkers(ensured.content, markerMap, built.values);
  if (!spliced.ok) {
    const names = spliced.missingMarkers.map((m) => `SEOAI:${m}`).join(', ');
    // A head-scoped field (canonical, open-graph, ...) is never auto-inserted
    // at EOF — it can only be auto-created nested inside a human-placed
    // SEOAI:HEAD region (see marker-merge.js). If its own marker is still
    // missing after ensureMarkers ran, that region doesn't exist yet — tell
    // the operator exactly what one-time step to do, not just which marker
    // name is missing.
    const missingFields = Object.entries(markerMap).filter(([, markerName]) => spliced.missingMarkers.includes(markerName)).map(([field]) => field);
    const headHint = missingFields.some(isHeadScopedField)
      ? ` This field must be placed inside a <!-- SEOAI:HEAD:START -->...<!-- SEOAI:HEAD:END --> region within <head> — add that region to ${filePath} first (a one-time step per template), then this field's own marker is created automatically.`
      : '';
    return { ok: false, reason: 'no-insertion-marker', error: `Marker(s) not found in the live file: ${names}. Add them to ${filePath} before this can be applied.${headHint}` };
  }

  return {
    ok: true, filePath, oldContent: file.content, newContent: spliced.newContent, changedRegions: spliced.changedRegions,
    renderMode: mode, renderModeConfidence: inspection?.confidence ?? null, renderModeReason: inspection?.reason ?? null,
  };
}

// For an already-implemented draft, "preview" means something different:
// there's no pending change to review, just the real content that's
// actually live right now. No recomputation, no render-mode re-inspection —
// the marker already holds whatever was genuinely applied at merge time, so
// this just reads it, verbatim. Kept deliberately separate from
// computeMarkerMerge rather than reusing it with a flag, since recomputing
// a "diff" against content that's already merged would be comparing the
// live file to itself and could even produce a misleading result if
// something (like render mode) would resolve differently today than it did
// at merge time.
async function previewLiveMarkerContent(site, draft) {
  const page = draft.content?.page || draft.input?.page;
  const filePath = resolveFile(site, page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}".` };
  }

  const markerMap = resolveMarkers(site, page, draft.action_type);
  if (!markerMap) {
    const { field, marker } = markerConfigExample(draft.action_type);
    return { ok: false, reason: 'no-insertion-marker', error: `No markers configured for "${page}" — add e.g. {"${field}":"${marker}"} to url_file_map.pages[...].placements or .markers.` };
  }

  const branch = baseBranch(site);
  const file = await getFileContent(site, filePath, branch);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${branch}".` };
  }

  const changedRegions = Object.entries(markerMap)
    .map(([field, markerName]) => ({ field, markerName, content: getMarkerContent(file.content, markerName) }))
    .filter((r) => r.content !== null);

  if (!changedRegions.length) {
    return { ok: false, reason: 'no-insertion-marker', error: `No SEOAI markers found in ${filePath} for this draft's fields — it may have been removed or overwritten since this draft was implemented.` };
  }

  return { ok: true, filePath, live: true, changedRegions };
}

// Pushes a real branch (forked from the site's default branch) with the
// real change — not merged yet (see mergeToStage below). Staff reviews the
// real diff (Draft Preview panel, unchanged — same computeMarkerMerge
// output) before deciding to merge the PR. `opts.renderModeOverride` is
// ignored by llms-txt (no mode concept) and simply unused for anything but
// marker-merge types.
export async function apply(site, draft, opts = {}) {
  const batchInfo = await getOrInitBatchBranch(site);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : baseBranch(site);
  if (draft.action_type === 'llms-txt') return pushLlmsTxtBranch(site, draft, batchInfo);
  if (draft.action_type === 'security-headers') return pushSecurityHeadersBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'robots-fix') return pushRobotsFixBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'redirect-fix') return pushRedirectFixBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'broken-link-fix') return pushBrokenLinkFixBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'html-lang') return pushHtmlLangBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'viewport') return pushViewportBranch(site, draft, batchInfo, beforeRef);
  if (MARKER_MERGE_TYPES.has(draft.action_type)) {
    const merged = await computeMarkerMerge(site, draft, opts.renderModeOverride, beforeRef);
    if (!merged.ok) return merged;
    const pushed = await pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
    return pushed.ok ? { ...pushed, renderMode: merged.renderMode } : pushed;
  }
  return { ok: false, reason: 'merge-strategy-not-implemented', error: `No merge strategy for action type "${draft.action_type}".` };
}

// branch_pushed -> PR opened into the site's default branch (human merges
// on GitHub). Despite the name — kept as-is because implementers/registry.js
// checks for this exact export name at load time (see
// server/implementers/registry.js) — this doesn't merge into stage at all,
// it opens a PR. draft.branch_name is already real (persisted by
// markDraftBranchPushed after apply() above succeeded) — this step only
// opens the PR, no new file writes.
export async function mergeToStage(site, draft) {
  if (!draft.branch_name) return { ok: false, reason: 'no-branch', error: 'No branch has been pushed for this draft yet.' };
  return openPrForBranch(site, draft, draft.branch_name);
}

// Zero-write dry run — the real diff a reviewer sees before approving,
// computed by the exact same merge function apply() uses. llms-txt has no
// "merge" step (its draft content already IS the full file body), so its
// preview is just that raw content shown as the "after" — still real, still
// a genuine before/after via a live fetch of the current file.
export async function preview(site, draft, opts = {}) {
  if (draft.status === 'implemented') {
    if (draft.action_type === 'llms-txt') {
      const llmsPath = resolveSiteRootFile(site, 'llmsTxt');
      if (!llmsPath) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.llmsTxt is not configured.' };
      const file = await getFileContent(site, llmsPath, baseBranch(site));
      return { ok: true, filePath: llmsPath, live: true, changedRegions: [{ field: 'llmsTxt', content: file?.content || '' }] };
    }
    if (draft.action_type === 'security-headers') return previewLiveSecurityHeaders(site, draft);
    if (draft.action_type === 'robots-fix') return previewLiveRobotsFix(site, draft);
    if (draft.action_type === 'redirect-fix') return previewLiveRedirectFix(site, draft);
    if (draft.action_type === 'broken-link-fix') return previewLiveBrokenLinkFix(site, draft);
    if (draft.action_type === 'html-lang') return previewLiveHtmlLang(site, draft);
    if (draft.action_type === 'viewport') return previewLiveViewport(site, draft);
    if (MARKER_MERGE_TYPES.has(draft.action_type)) return previewLiveMarkerContent(site, draft);
    return { ok: false, reason: 'merge-strategy-not-implemented', error: `No live view available for "${draft.action_type}" yet.` };
  }

  const batchInfo = await getOrInitBatchBranch(site);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : baseBranch(site);

  if (draft.action_type === 'llms-txt') {
    const llmsPath = resolveSiteRootFile(site, 'llmsTxt');
    if (!llmsPath) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.llmsTxt is not configured.' };
    const file = await getFileContent(site, llmsPath, beforeRef);
    return { ok: true, filePath: llmsPath, oldContent: file?.content || '', newContent: draft.content.llmsTxt };
  }
  if (draft.action_type === 'security-headers') return computeSecurityHeadersMerge(site, draft, beforeRef);
  if (draft.action_type === 'robots-fix') return computeRobotsFixMerge(site, draft, beforeRef);
  if (draft.action_type === 'redirect-fix') return computeRedirectFixMerge(site, draft, beforeRef);
  if (draft.action_type === 'broken-link-fix') return computeBrokenLinkFixMerge(site, draft, beforeRef);
  if (draft.action_type === 'html-lang') return computeHtmlLangMerge(site, draft, beforeRef);
  if (draft.action_type === 'viewport') return computeViewportMerge(site, draft, beforeRef);
  if (MARKER_MERGE_TYPES.has(draft.action_type)) return computeMarkerMerge(site, draft, opts.renderModeOverride, beforeRef);
  return { ok: false, reason: 'merge-strategy-not-implemented', error: `No preview available for "${draft.action_type}" yet.` };
}
