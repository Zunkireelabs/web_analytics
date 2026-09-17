import { resolveFile, resolveSiteRootFile, resolveMarkers, resolveLinkDataSources, MARKER_FIELD_BY_ACTION_TYPE } from './lib/url-file-map.js';
import { pushDraftBranch, openPrForBranch, getOrInitBatchBranch, baseBranch, batchBranchConflictError } from './lib/github-ops.js';
import { getFileContent } from '../github/client.js';
import { searchRepoLocalForStrings } from './lib/repo-local-search.js';
import { buildMergeValues, spliceMarkers, getMarkerContent, ANALYTICS_PROVIDER_FIELDS } from './lib/marker-merge.js';
import { resolveInsertion, buildUnresolvedInsertionFailure } from './lib/insertion-engine.js';
import { spliceHashBlock, validateNginxBraces, getHashMarkerContent } from './lib/hash-marker-merge.js';
import { patchSoftNotFoundFallback } from './lib/soft-404-inject.js';
import { patchRedirectChain } from './lib/redirect-chain-nginx-inject.js';
import { removeUrlsFromSitemap } from './lib/sitemap-removal-inject.js';
import { injectHtmlLang, getHtmlTag } from './lib/html-lang-inject.js';
import { setViewportMeta, getViewportMeta } from './lib/viewport-inject.js';
import { rewriteHref, stripLink, getAnchorsForHref, hrefVariants } from './lib/href-rewrite-inject.js';
import { inspectRenderMode, hasExistingFaqSchema, CONFIDENCE_THRESHOLD, INSPECTABLE_ACTION_TYPES } from './lib/render-inspector.js';
import { decideFaqRenderMode } from './lib/faq-render-mode.js';
import { checkTemplateFreshness, COMPONENT_TEMPLATE_KEY, siteHasUsableDesignProfile, checkDesignIntegrityGate } from './lib/design-drift.js';
import { checkResponsivePreview, describeResponsiveRegressions } from '../generators/lib/responsive-preview-gate.js';
import { discoverPaginationRoutes, matchPaginationRoute } from './lib/pagination-routes.js';
import { checkSharedTemplateWrite } from './lib/action-scope.js';
import { detectConflictMarkers } from './lib/conflict-marker-check.js';
import { safeMessage } from '../lib/errors.js';
import { hasDangerousReference, hasExternalReferences, findIdScopesInOrder, classifyScopeCountMismatch, applyScopeRenames } from './lib/duplicate-id-inject.js';
import { computeSchemaRepairMerge, pushSchemaRepairBranch, previewLiveSchemaRepair } from './lib/schema-repair-inject.js';
import { computeContentIntegrityMerge, pushContentIntegrityBranch, previewLiveContentIntegrity } from './lib/content-integrity-inject.js';
import { computeAltTextMerge, pushAltTextBranch, previewLiveAltText } from './lib/alt-text-inject.js';
import { computeBlogImageMerge, pushBlogImageBranch, previewLiveBlogImage } from './lib/blog-image-inject.js';
import { computeSitemapExcludeMerge, pushSitemapExcludeBranch, previewLiveSitemapExclude } from './lib/sitemap-frontmatter-exclude-inject.js';
import { findRootObjectBounds, findObjectFieldRange, findArrayFieldRange, findScalarFieldRange, removeArrayItemByField, spliceScalarField, assertValidContent } from './adapters/lib/js-data-splice.js';


export const meta = {
  id: 'backend',
  name: 'Backend/SEO Implementer',
  description: 'Applies machine-readable draft content (schema markup, meta tags, FAQ schema, internal links, llms.txt/robots.txt, security headers, html lang, sitemap additions) as a real pull request.',
  handles: ['schema', 'meta-title', 'faq', 'internal-links', 'llms-txt', 'security-headers', 'html-lang', 'viewport', 'robots-fix', 'robots-bootstrap', 'redirect-fix', 'broken-link-fix', 'canonical', 'open-graph', 'expand-content', 'refresh-content', 'qa-content', 'sitemap', 'sitemap-removal', 'sitemap-frontmatter-exclude', 'analytics-install', 'duplicate-id-fix', 'breadcrumbs', 'schema-repair', 'alt-text', 'content-integrity-repair', 'blog-image', 'soft-404-nginx', 'redirect-chain-nginx', 'compression-nginx'],
};

// Every backend.js type with a real merge strategy — see lib/marker-merge.js
// for why (a literal splice between human-placed marker comments, the one
// merge approach that never requires parsing an unknown site's real
// templating syntax). schema is a single self-contained JSON-LD block, same
// shape as faq's; internal-links renders its suggestion list to a
// deterministic <ul> first (see marker-merge.js's renderLinksHtml) — neither
// needs a different mechanism, just its own marker name and value-builder.
// Exported so server/scripts/bootstrap-structural-markers.js (the
// onboarding/migration warm-cache tool) iterates the SAME real set of
// marker-merge action types this implementer actually handles, rather than
// keeping its own independent, driftable copy of the list.
export const MARKER_MERGE_TYPES = new Set(['meta-title', 'faq', 'schema', 'internal-links', 'canonical', 'open-graph', 'expand-content', 'refresh-content', 'qa-content', 'analytics-install', 'breadcrumbs']);

// MARKER_FIELD_BY_ACTION_TYPE (imported above, from url-file-map.js — the
// same table PLATFORM_DEFAULT_MARKERS now builds its defaults from) is used
// here only to build an accurate, type-specific example in the "no markers
// configured" error below, never hardcoded to one type regardless of which
// draft actually triggered it. analytics-install has no single static field
// — see ANALYTICS_PROVIDER_FIELDS (marker-merge.js): each provider
// (ga4/facebook-pixel) gets its own field/marker so two analytics-install
// drafts for different providers don't clobber each other's marker on apply.
function markerConfigExample(actionType, provider) {
  const field = actionType === 'analytics-install'
    ? (ANALYTICS_PROVIDER_FIELDS[provider] || Object.values(ANALYTICS_PROVIDER_FIELDS).join('" and "'))
    : (MARKER_FIELD_BY_ACTION_TYPE[actionType] || 'field');
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

// sitemap is site-level like llms-txt, and draft.content.sitemapXml is
// already the complete new file body (server/generators/sitemap.js merges
// existing entries + missing URLs itself, additive-only) — a straight file
// write, zero content transformation here, same shape as pushLlmsTxtBranch.
async function pushSitemapBranch(site, draft, batchInfo) {
  const path = resolveSiteRootFile(site, 'sitemap');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.sitemap is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  return pushDraftBranch(site, draft, [{ path, content: draft.content.sitemapXml }], batchInfo);
}

// The removal counterpart to pushSitemapBranch above — unlike that one
// (whose sitemapXml is already the complete new body, computed additively
// by generators/sitemap.js at draft time), this has to re-fetch the LIVE
// sitemap here and remove the exact matching <url> block(s) fresh, since
// the whole point is reacting to whatever the sitemap currently says, not
// whatever it said when the draft was first generated. All-or-nothing
// (implementers/lib/sitemap-removal-inject.js): any requested URL that's no
// longer found as an exact entry refuses the WHOLE draft rather than
// silently removing only some of it.
async function computeSitemapRemovalMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'sitemap');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.sitemap is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
  const removed = removeUrlsFromSitemap(file.content, draft.content.removeUrls);
  if (!removed.ok) return removed;
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: removed.newContent,
    changedRegions: [{ field: 'removedUrls', before: draft.content.removeUrls.join(', '), after: '(removed)' }],
  };
}

async function pushSitemapRemovalBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeSitemapRemovalMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveSitemapRemoval(site, draft) {
  const path = resolveSiteRootFile(site, 'sitemap');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.sitemap is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'removedUrls', content: file.content }] };
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
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
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

// Real, hash-comment-marker splice for the nginx response-compression block
// — same mechanism as computeSecurityHeadersMerge just above (its own
// `# SEOAI:COMPRESSION:START/END` marker pair, splices draft.content.nginxBlock
// verbatim, same brace-balance guardrail since there's still no way to run a
// real `nginx -t` here). Kept as its own dedicated marker rather than reusing
// SECURITY-HEADERS: compression and security headers are independent
// concerns a site could onboard one without the other, and splicing two
// unrelated features through one shared marker region would make either
// draft silently clobber whatever the other last wrote there.
async function computeCompressionMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
  const spliced = spliceHashBlock(file.content, 'COMPRESSION', draft.content.nginxBlock);
  if (!spliced.ok) return spliced;
  const validated = validateNginxBraces(spliced.newContent);
  if (!validated.ok) return validated;
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: spliced.newContent,
    changedRegions: [{ field: 'nginxBlock', markerName: 'COMPRESSION', before: spliced.changedRegion.before, after: spliced.changedRegion.after }],
  };
}

async function pushCompressionBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeCompressionMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveCompression(site, draft) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  const content = getHashMarkerContent(file.content, 'COMPRESSION');
  if (content === null) {
    return { ok: false, reason: 'no-insertion-marker', error: `No SEOAI:COMPRESSION marker found in ${path} — it may have been removed or overwritten since this draft was implemented.` };
  }
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'nginxBlock', markerName: 'COMPRESSION', content }] };
}

// Not marker-based (no human ever places a marker for this — it's a single
// existing line, not a region to insert into) — an exact-text splice that
// refuses rather than guesses if the live file doesn't contain precisely the
// line this fix knows how to rewrite (see lib/soft-404-inject.js). Same
// brace-balance guardrail as the marker-based nginx merge above, for the
// same reason (no real `nginx -t` available here).
async function computeSoft404NginxMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
  const patched = patchSoftNotFoundFallback(file.content);
  if (!patched.ok) return patched;
  const validated = validateNginxBraces(patched.newContent);
  if (!validated.ok) return validated;
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: patched.newContent,
    changedRegions: [{ field: 'tryFiles', before: patched.before, after: patched.after }],
  };
}

async function pushSoft404NginxBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeSoft404NginxMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveSoft404Nginx(site, draft) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'tryFiles', content: file.content }] };
}

// Same exact-match-or-refuse, no-marker splice as soft-404-nginx above, one
// level more conservative: it also refuses if the live rule's CURRENT
// target has drifted from what the real redirect walk observed
// (draft.content.currentHopTarget) — a config change since detection means
// this isn't confidently the same rule any more, not just "not found."
async function computeRedirectChainNginxMerge(site, draft, beforeRef) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  const file = await getFileContent(site, path, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;

  let sourcePath;
  try { sourcePath = new URL(draft.content.page).pathname; } catch { return { ok: false, reason: 'invalid-page', error: `"${draft.content.page}" is not a valid URL.` }; }

  const patched = patchRedirectChain(file.content, sourcePath, draft.content.currentHopTarget, draft.content.finalTarget);
  if (!patched.ok) return patched;
  const validated = validateNginxBraces(patched.newContent);
  if (!validated.ok) return validated;
  return {
    ok: true, filePath: path, oldContent: file.content, newContent: patched.newContent,
    changedRegions: [{ field: 'redirectTarget', before: patched.before, after: patched.after }],
  };
}

async function pushRedirectChainNginxBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeRedirectChainNginxMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveRedirectChainNginx(site, draft) {
  const path = resolveSiteRootFile(site, 'nginxConfig');
  if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.nginxConfig is not configured.' };
  const file = await getFileContent(site, path, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${path} does not exist on branch "${baseBranch(site)}".` };
  return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'redirectTarget', content: file.content }] };
}

// robots-bootstrap is site-level like llms-txt/sitemap, and
// draft.content.robotsTxt is already the complete new file body
// (server/generators/robots-bootstrap.js) — a straight file write, zero
// content transformation, same shape as pushSitemapBranch. Deliberately NOT
// a hash-marker splice like robots-fix.js below: this generator's whole job
// is creating the file for a site that has none, so there is nothing
// existing to splice into (an existing file is robots-fix.js's job, not
// this one's — technical-seo.js only ever recommends robots-bootstrap when
// robotsTxtFound is false, so this never risks overwriting a real file).
async function pushRobotsBootstrapBranch(site, draft, batchInfo) {
  const path = resolveSiteRootFile(site, 'robotsTxt');
  if (!path) {
    return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.robotsTxt is not configured — set it via `npm run connect-repo` before this can be applied.' };
  }
  return pushDraftBranch(site, draft, [{ path, content: draft.content.robotsTxt }], batchInfo);
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
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
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
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
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
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
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
export async function computeRedirectFixMerge(site, draft, beforeRef) {
  const filePath = resolveFile(site, draft.content.page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${draft.content.page}" — add one via \`npm run connect-repo\` before this can be applied.` };
  }
  const file = await getFileContent(site, filePath, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;
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

// duplicate-id-fix.js's own generator deliberately stays advisory for the
// general case — no implementer used to be registered for it at all (see
// that file's header comment). This auto-applies only the one shape that's
// provably safe: a duplicate id on an SVG paint-def tag
// (linearGradient/radialGradient/clipPath/mask) that's referenced solely by
// `url(#id)` inside its own <svg> block — see lib/duplicate-id-inject.js.
// Every other duplicate id (referenced by CSS, JS, or an anchor link,
// anywhere in the repo) refuses rather than guesses, all-or-nothing per
// draft: if any one occurrence in the plan isn't safe, none of them are
// applied, so a reviewer never has to reason about a half-renamed page.
const SVG_PAINT_DEF_TAGS = new Set(['lineargradient', 'radialgradient', 'clippath', 'mask']);

export async function computeDuplicateIdFixMerge(site, draft, beforeRef) {
  const page = draft.content?.page;
  const filePath = resolveFile(site, page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
  }
  const file = await getFileContent(site, filePath, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;

  const entries = draft.content?.fixPlan || [];
  if (!entries.length) {
    return { ok: false, reason: 'draft-not-ready', error: 'This draft has no renameable occurrences.' };
  }

  const unsafe = [];
  // Entries where the live file now has exactly ONE occurrence of an id that
  // was drafted as a duplicate (2+) — not an ambiguous "file changed since
  // scanned" case like every other mismatch below: one occurrence means
  // there is no duplicate left to rename, full stop. Kept separate from
  // `unsafe` so a plan that's ENTIRELY made of these (see below) is reported
  // as already fixed rather than as a defect needing a human to re-verify
  // something that's already true. Real incident, site 1 (2026-09-09 to
  // 2026-09-11): id="service-icon-gradient" repeated this identically for
  // days because another draft (or a direct edit) had already deduplicated
  // it, and this function had no way to say so.
  const alreadyResolved = [];
  const edits = [];
  const changedRegions = [];
  for (const entry of entries) {
    const occurrences = entry.occurrences || [];
    const renamable = occurrences.filter((occ) => !occ.keep);
    if (!renamable.length) continue;

    const nonGradientTag = occurrences.find((occ) => !SVG_PAINT_DEF_TAGS.has(String(occ.tag).toLowerCase()));
    if (nonGradientTag) {
      unsafe.push(`id="${entry.id}" is on a <${nonGradientTag.tag}> element, not a gradient/clipPath/mask def — renaming it could affect a CSS selector, JS lookup, or anchor link this fix can't see.`);
      continue;
    }
    if (hasDangerousReference(file.content, entry.id)) {
      unsafe.push(`id="${entry.id}" is referenced by something other than a plain url(#...) fill in ${filePath} (a CSS selector, getElementById/querySelector call, or #anchor) — refusing to rename it automatically.`);
      continue;
    }
    if (await hasExternalReferences(site, entry.id, filePath, beforeRef, searchRepoLocalForStrings)) {
      unsafe.push(`id="${entry.id}" also appears in another file in this repo — can't confirm it's safe to rename without a human checking that reference.`);
      continue;
    }

    // Positional, not snippet-text, matching — see findIdScopesInOrder's
    // comment: when occurrences are byte-identical duplicated components, a
    // substring search can't tell "the second one" from "the first one",
    // only document order can. scopes.length must equal occurrences.length
    // exactly, or the live file no longer matches what was scanned.
    const scopes = findIdScopesInOrder(file.content, entry.id);
    if (!scopes || scopes.length !== occurrences.length) {
      if (classifyScopeCountMismatch(scopes, occurrences.length) === 'resolved') {
        alreadyResolved.push(`id="${entry.id}" now has only 1 occurrence in ${filePath} (was ${occurrences.length}) — already deduplicated.`);
      } else {
        unsafe.push(`id="${entry.id}" now has ${scopes ? scopes.length : 'a different number of'} occurrence(s) in <svg> blocks in ${filePath}, not the ${occurrences.length} this plan was drafted from — the file has changed since it was scanned.`);
      }
      continue;
    }

    occurrences.forEach((occ, i) => {
      if (occ.keep) return;
      const scope = scopes[i];
      edits.push({ start: scope.start, end: scope.end, oldId: entry.id, newId: occ.suggestedId });
      changedRegions.push({ field: 'id', markerName: entry.id, before: `id="${entry.id}"`, after: `id="${occ.suggestedId}"` });
    });
  }

  if (unsafe.length) {
    return { ok: false, reason: 'not-provably-safe', error: `Can't safely auto-apply this duplicate-id fix: ${unsafe.join(' ')} Apply the fix plan by hand instead.` };
  }
  if (!edits.length && alreadyResolved.length) {
    return { ok: false, reason: 'already-resolved', error: `Nothing left to apply: ${alreadyResolved.join(' ')}` };
  }
  if (!edits.length) {
    return { ok: false, reason: 'draft-not-ready', error: 'This draft has no renameable occurrences.' };
  }

  const newContent = applyScopeRenames(file.content, edits);
  return { ok: true, filePath, oldContent: file.content, newContent, changedRegions };
}

async function pushDuplicateIdFixBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeDuplicateIdFixMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

async function previewLiveDuplicateIdFix(site, draft) {
  const page = draft.content?.page;
  const filePath = resolveFile(site, page);
  if (!filePath) return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}".` };
  const file = await getFileContent(site, filePath, baseBranch(site));
  if (!file) return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${baseBranch(site)}".` };

  const toRename = (draft.content?.fixPlan || []).flatMap((entry) =>
    (entry.occurrences || []).filter((occ) => !occ.keep).map((occ) => ({ ...occ, id: entry.id }))
  );
  const changedRegions = toRename
    .map((occ) => {
      const idAttr = `id="${occ.suggestedId}"`;
      const idx = file.content.indexOf(idAttr);
      return idx === -1 ? null : { field: 'id', markerName: occ.id, content: file.content.slice(idx, idx + 160) };
    })
    .filter(Boolean);

  if (!changedRegions.length) {
    return { ok: false, reason: 'no-insertion-marker', error: `None of this draft's renamed ids were found in ${filePath} — it may have changed since this draft was implemented.` };
  }
  return { ok: true, filePath, live: true, changedRegions };
}

const CODE_SEARCH_MAX_CANDIDATES = 5; // small N — bounds worst-case file-content fetches from the repo-local search fallback

// One readable sentence summarizing every attempt across both layers, for
// the single `error` string surfaced to a human — full per-attempt detail
// still lives in `attempted` for anyone (UI, logs, MCP) that wants it.
//
// `coverageIncomplete` distinguishes two very different kinds of "not
// found" that used to produce the identical sentence (and so classified
// identically — see LINK_TARGET_UNRESOLVABLE_FRAGMENT in
// lib/attempt-classification.js): before the repo-local search fallback
// read the whole repo as one tarball (2026-09-08), "no candidates" genuinely
// meant "not found in the small bounded sample we could afford to check",
// so telling a human to add a url_file_map entry for a shared header/footer
// was the right guess. Coverage is now complete by construction whenever
// `!coverageIncomplete` — so when the search ALSO found zero candidate
// files at all, that is no longer a coverage gap, it is a confirmed fact:
// this href is not hardcoded in any real candidate file in the repo. A
// url_file_map entry cannot fix that; the finding itself is stale (the
// href was removed since detection, or it renders from something other
// than static template/markup text) and needs a fresh crawl, not a mapping.
function summarizeBrokenLinkAttempts(sourcePages, href, attempted, coverageIncomplete) {
  const sourceAttempts = attempted.filter((a) => a.matchedVia === 'source-page');
  const noMapping = sourceAttempts.filter((a) => a.reason === 'no-file-mapping').length;
  const noAnchor = sourceAttempts.length - noMapping;
  const dataSourceAttempts = attempted.filter((a) => a.matchedVia === 'link-data-source');
  const globalAttempts = attempted.filter((a) => a.matchedVia === 'global-link-data-file');
  const searchAttempts = attempted.filter((a) => a.matchedVia === 'repo-local-search');
  const searchError = searchAttempts.find((a) => a.reason === 'repo-local-search-error');

  const sourceSummary = `${sourcePages.length} known source page(s) (${noMapping} have no url_file_map entry; ${noAnchor} mapped file(s) don't contain this link)`;
  const dataSourceSummary = dataSourceAttempts.length
    ? `; also checked ${dataSourceAttempts.length} configured data-array source(s), none matched`
    : '';
  const globalSummary = globalAttempts.length
    ? `; also checked the site-wide link config file, ${globalAttempts[0].reason === 'file-not-found' ? 'which could not be read' : 'no match'}`
    : '';
  const confirmedAbsent = !coverageIncomplete && !searchError && searchAttempts.length === 0;
  const searchSummary = searchError
    ? `repository-local search fallback failed: ${searchError.error}`
    : searchAttempts.length
      ? `also checked ${searchAttempts.length} repository-local search candidate(s), none matched`
      : confirmedAbsent
        ? 'a full repository search (not a bounded sample) found this href hardcoded nowhere in it'
        : 'repository-local search fallback found no candidates';

  const trailer = confirmedAbsent
    ? ' This link is confirmed absent from every real candidate file in the repo — the finding is likely stale rather than missing a mapping.'
    : '';

  return `No file could be found or safely stripped for href="${href}" across ${sourceSummary}${dataSourceSummary}${globalSummary} — ${searchSummary}.${trailer}`;
}

// The id to match within a linkDataSources dataFile is the page URL's own
// last path segment — same convention adapters/data-array-content.js's
// idFromPageUrl already establishes for "one entry per page, keyed by its
// own URL slug" data files (productsDetails.json, servicesDetails.json).
function lastPathSegment(pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { return null; }
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

// Pure content -> content edit for one linkDataSources config against
// already-fetched file content — split out from the fetch/dedupe loop below
// so multiple matches within the SAME dataFile (e.g. two different pages'
// dead links both living in productsDetails.json) chain onto each other's
// already-edited content instead of each starting fresh from beforeRef and
// clobbering the other's edit.
export function applyLinkDataSourceEdit(content, page, href, source) {
  const id = lastPathSegment(page);
  if (!id) return { ok: false, reason: 'no-file-mapping', error: `Could not derive an id from "${page}".` };

  const format = source.format || 'json-array';
  const rootBounds = findRootObjectBounds(content);
  if (!rootBounds) return { ok: false, reason: 'no-match', error: `Could not find a root object in ${source.dataFile}.` };
  const entryRange = findObjectFieldRange(content, rootBounds, id, format);
  if (!entryRange) return { ok: false, reason: 'no-match', error: `No "${id}" entry found in ${source.dataFile}.` };

  const urlField = source.urlField || 'url';

  // Two real shapes seen on zunkireelabs-web: a "Resources" LIST of link
  // objects living under itemsField (below — the original case this config
  // was built for), and a single scalar link field directly on the entry
  // itself (productsDetails.json's per-product "loginUrl" — one dead
  // product/login URL, never a list item). Config with no itemsField means
  // the latter: clear the field's value in place (matching the same
  // "template already treats an empty/falsy value as no link" contract a
  // stripped <a href> relies on) rather than trying to remove a whole array
  // entry that doesn't exist here.
  if (!source.itemsField) {
    const scalarRange = findScalarFieldRange(content, entryRange, urlField, format);
    if (!scalarRange) return { ok: false, reason: 'no-match', error: `"${id}" has no "${urlField}" field in ${source.dataFile}.` };
    const currentValue = content.slice(scalarRange.valueStart + 1, scalarRange.valueEnd - 1);
    if (!hrefVariants(href).includes(currentValue)) {
      return { ok: false, reason: 'no-match', error: `"${id}"'s "${urlField}" in ${source.dataFile} is "${currentValue}", not "${href}".` };
    }
    const newContent = spliceScalarField(content, entryRange, urlField, '', format);
    if (!newContent) return { ok: false, reason: 'no-match', error: `Could not clear "${urlField}" on "${id}" in ${source.dataFile}.` };
    const check = assertValidContent(newContent, format);
    if (!check.ok) return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${source.dataFile}'s syntax (${check.error}) — refused to apply.` };
    return { ok: true, newContent };
  }

  const arrayRange = findArrayFieldRange(content, entryRange, source.itemsField, format);
  if (!arrayRange) return { ok: false, reason: 'no-match', error: `"${id}" has no "${source.itemsField}" array in ${source.dataFile}.` };

  const newContent = removeArrayItemByField(content, arrayRange, urlField, hrefVariants(href), format);
  if (!newContent) return { ok: false, reason: 'no-match', error: `No "${urlField}" matching "${href}" found in ${source.dataFile}'s "${id}" entry.` };

  const check = assertValidContent(newContent, format);
  if (!check.ok) return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${source.dataFile}'s syntax (${check.error}) — refused to apply.` };

  return { ok: true, newContent };
}

// A dead link that lives in neither the page's own template nor a per-page
// data source (Layers 1/1.5 above) but in one small site-wide config object
// instead — e.g. zunkireelabs-web's src/_data/site.json `social.{twitter,
// github,linkedin}`, rendered into every page's Organization schema via the
// shared base layout. Configured once per site (siteRoot.globalLinkDataFile,
// see resolveGlobalLinkDataFile below), never guessed at: only a file the
// tenant's own repo setup named is ever touched here.
//
// A full JSON.parse/JSON.stringify round-trip, deliberately unlike the
// surgical text-splicing js-data-splice.js uses elsewhere: those exist to
// preserve a JS file's exact formatting/comments around the one field being
// touched, which plain JSON has none of. Re-serializing at a fixed 2-space
// indent is the one formatting cost, applied to a small, purely-data file.
//
// Only ever removes the field when the href appears EXACTLY ONCE in the
// whole document — a href appearing under two different keys (unlikely, but
// not impossible in a hand-edited config file) is refused rather than
// guessed at, the same "not provably safe" stance every other Layer here
// already takes.
export function stripGlobalJsonLink(content, href) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  const matches = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && value === href) matches.push([...path, key]);
      else if (value && typeof value === 'object') walk(value, [...path, key]);
    }
  };
  walk(data, []);
  if (matches.length !== 1) return null;

  let parent = data;
  const path = matches[0];
  for (let i = 0; i < path.length - 1; i++) parent = parent[path[i]];
  delete parent[path[path.length - 1]];
  return `${JSON.stringify(data, null, 2)}\n`;
}

export async function computeBrokenLinkFixMerge(site, draft, beforeRef) {
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
  // dataFile -> { oldContent, content, matchedFrom } — accumulates edits
  // across sourcePages so two matches in the SAME shared data file compose
  // instead of the second overwriting the first's work.
  const dataFileEdits = new Map();

  // Layer 1: every known source page's mapped file, not just the first —
  // and every one that genuinely matches, not just the first success. The
  // same dead href is often hardcoded on more than one page's own file.
  for (const page of sourcePages) {
    const filePath = resolveFile(site, page);
    if (!filePath) {
      attempted.push({ page, matchedVia: 'source-page', reason: 'no-file-mapping' });
    } else if (!seenPaths.has(filePath)) {
      seenPaths.add(filePath);
      const file = await getFileContent(site, filePath, beforeRef);
      if (!file) {
        attempted.push({ page, filePath, matchedVia: 'source-page', reason: 'file-not-found' });
      } else {
        const conflict = detectConflictMarkers(file.content);
        if (conflict) {
          attempted.push({ page, filePath, matchedVia: 'source-page', reason: conflict.reason, error: conflict.error });
        } else {
          const stripped = stripLink(file.content, href);
          if (!stripped.ok) {
            attempted.push({ page, filePath, matchedVia: 'source-page', reason: stripped.reason, error: stripped.error });
          } else {
            files.push({
              filePath, oldContent: file.content, newContent: stripped.newContent,
              changedRegions: [{ field: 'href', before: href, after: null }],
              matchedVia: 'source-page', matchedFrom: page,
            });
          }
        }
      }
    }

    // Layer 1.5: shared data-array sources configured for this page (e.g. a
    // product page's "Resources" links, rendered by a shared layout from
    // productsDetails.json — not hardcoded in the page's own template file
    // at all, so Layer 1 above can never find them there; see
    // resolveLinkDataSources's doc comment for how this was discovered).
    for (const source of resolveLinkDataSources(site, page)) {
      let working = dataFileEdits.get(source.dataFile);
      if (!working) {
        const file = await getFileContent(site, source.dataFile, beforeRef);
        if (!file) { attempted.push({ page, filePath: source.dataFile, matchedVia: 'link-data-source', reason: 'file-not-found' }); continue; }
        const conflict = detectConflictMarkers(file.content);
        if (conflict) { attempted.push({ page, filePath: source.dataFile, matchedVia: 'link-data-source', reason: conflict.reason, error: conflict.error }); continue; }
        working = { oldContent: file.content, content: file.content, matchedFrom: page };
        dataFileEdits.set(source.dataFile, working);
      }

      const result = applyLinkDataSourceEdit(working.content, page, href, source);
      if (!result.ok) { attempted.push({ page, filePath: source.dataFile, matchedVia: 'link-data-source', reason: result.reason, error: result.error }); continue; }
      working.content = result.newContent;
      working.matchedFrom = page;
    }
  }

  for (const [filePath, working] of dataFileEdits) {
    if (working.content === working.oldContent) continue; // configured but no entry actually matched this href
    files.push({
      filePath, oldContent: working.oldContent, newContent: working.content,
      changedRegions: [{ field: 'href', before: href, after: null }],
      matchedVia: 'link-data-source', matchedFrom: working.matchedFrom,
    });
  }

  // Layer 1.6: one site-wide config file (see stripGlobalJsonLink above) —
  // checked once per draft, not per source page, since it isn't scoped to
  // any one page. Only reached when nothing page-specific matched, same
  // "last resort before the bounded search" position as Layer 2.
  const globalLinkDataFile = site.url_file_map?.siteRoot?.globalLinkDataFile;
  if (!files.length && globalLinkDataFile && !seenPaths.has(globalLinkDataFile)) {
    seenPaths.add(globalLinkDataFile);
    const file = await getFileContent(site, globalLinkDataFile, beforeRef);
    if (!file) {
      attempted.push({ filePath: globalLinkDataFile, matchedVia: 'global-link-data-file', reason: 'file-not-found' });
    } else {
      const newContent = stripGlobalJsonLink(file.content, href);
      if (!newContent) {
        attempted.push({ filePath: globalLinkDataFile, matchedVia: 'global-link-data-file', reason: 'no-match' });
      } else {
        files.push({
          filePath: globalLinkDataFile, oldContent: file.content, newContent,
          changedRegions: [{ field: 'href', before: href, after: null }],
          matchedVia: 'global-link-data-file',
        });
      }
    }
  }

  if (files.length) return { ok: true, files, attempted };

  // Layer 2: only when Layer 1 found ZERO matches anywhere — last resort,
  // never speculative.
  //
  // Repository-local search (Git Trees + Contents API), not GitHub's
  // /search/code: every site here authenticates as a GitHub App
  // installation, and App tokens silently return empty results from
  // /search/code on private repos — a real GitHub platform limitation
  // (github.com/orgs/community/discussions/113651), not something fixable
  // by using the App "correctly". A separate classic PAT could work around
  // it, but that would mean provisioning and trusting a second, differently
  // -scoped credential just for this one fallback; the Trees/Contents APIs
  // this app already relies on everywhere else are fully App-compatible, so
  // this searches those instead, bounded to real candidate files (see
  // repo-local-search.js) rather than a raw repo-wide grep.
  //
  // Every href variant is searched in the SAME pass (one tree fetch, one
  // bounded set of file fetches) — literal-text matching, so searching only
  // the absolute href would never surface a file that hardcodes the same
  // link site-relative (the exact form stripLink's own hrefVariants already
  // knows how to match once a file IS fetched).
  let candidates = new Set();
  let coverageIncomplete = false;
  try {
    const priorityDirs = [...new Set(
      attempted.filter((a) => a.filePath).map((a) => a.filePath.slice(0, a.filePath.lastIndexOf('/') + 1)).filter(Boolean)
    )];
    const result = await searchRepoLocalForStrings(site, beforeRef, hrefVariants(href), { priorityDirs });
    candidates = new Set(result.matches.slice(0, CODE_SEARCH_MAX_CANDIDATES));
    coverageIncomplete = result.truncatedCoverage;
  } catch (err) {
    // A missing credential (client.js's authHeaders) is a permanent
    // site-wide config gap, not a transient outage — using a generic
    // "temporarily unavailable" fallback for both used to make every
    // broken-link-fix needing this fallback retry forever under a message
    // that looked like it would resolve on its own, and fall through
    // attempt-classification.js's unrecognized-text default (ITEM_DEFECT)
    // instead of the NEEDS_HUMAN this genuinely is.
    const fallback = err.reason === 'missing-credential' ? err.message : 'the repository-local search fallback is temporarily unavailable';
    const { message } = safeMessage('backend.computeBrokenLinkFixMerge', err, fallback);
    attempted.push({ matchedVia: 'repo-local-search', reason: 'repo-local-search-error', error: message });
  }

  for (const filePath of candidates) {
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    const file = await getFileContent(site, filePath, beforeRef);
    if (!file) { attempted.push({ filePath, matchedVia: 'repo-local-search', reason: 'file-not-found' }); continue; }
    const conflict = detectConflictMarkers(file.content);
    if (conflict) { attempted.push({ filePath, matchedVia: 'repo-local-search', reason: conflict.reason, error: conflict.error }); continue; }
    const stripped = stripLink(file.content, href);
    if (!stripped.ok) { attempted.push({ filePath, matchedVia: 'repo-local-search', reason: stripped.reason, error: stripped.error }); continue; }
    files.push({
      filePath, oldContent: file.content, newContent: stripped.newContent,
      changedRegions: [{ field: 'href', before: href, after: null }],
      matchedVia: 'repo-local-search',
    });
  }

  if (files.length) return { ok: true, files, attempted };

  // coverageIncomplete: the bounded local search could not scan every real
  // candidate file (GitHub's own tree truncation, or this search's own file
  // cap) and found nothing in what it did scan. That is NOT the same claim
  // as "this href is hardcoded nowhere in the repo" — reported as its own
  // reason so it classifies as an external/coverage limitation rather than
  // a confident per-item defect (attempt-classification.js).
  //
  // confirmedAbsent (same condition summarizeBrokenLinkAttempts computes
  // internally for its own trailer sentence, duplicated here because THIS
  // caller needs the boolean itself, not just prose): a full, unbounded
  // repo search found the href hardcoded nowhere at all. That is proof the
  // recommendation's own premise (a link on this page still points here)
  // is stale, not evidence of an unresolvable defect — same "the generator
  // discovered live evidence the premise is gone" shape schema.js already
  // uses `stale: true` for. Without this, auto-remediation.js's refusal
  // counter only ever sees the generic 'no-match' reason code (never the
  // descriptive sentence this flag is derived from) and can't tell "this
  // citation is genuinely gone, close it" apart from "found candidate
  // files but couldn't safely strip any of them, still stuck" — so a
  // confirmed-resolved finding sat re-refusing itself forever instead of
  // closing. Kept as a DISTINCT reason code (not the same 'no-match') so
  // it stays gone from a link that's simply currently unresolvable.
  const searchAttempts = attempted.filter((a) => a.matchedVia === 'repo-local-search');
  const searchError = searchAttempts.find((a) => a.reason === 'repo-local-search-error');
  const confirmedAbsent = !coverageIncomplete && !searchError && searchAttempts.length === 0;
  return {
    ok: false,
    reason: attempted.length && attempted.every((a) => a.reason === 'no-file-mapping')
      ? 'no-file-mapping'
      : coverageIncomplete ? 'search-coverage-incomplete' : confirmedAbsent ? 'confirmed-absent' : 'no-match',
    stale: confirmedAbsent,
    error: coverageIncomplete
      ? `${summarizeBrokenLinkAttempts(sourcePages, href, attempted, coverageIncomplete)} The repository has more real candidate files than a bounded search can safely scan in one pass, and none of the scanned files matched — this could not be fully verified as absent from the repo.`
      : summarizeBrokenLinkAttempts(sourcePages, href, attempted, coverageIncomplete),
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
async function computeMarkerMerge(site, draft, renderModeOverride, beforeRef = baseBranch(site), { discoverRoutes = discoverPaginationRoutes } = {}) {
  const page = draft.content?.page || draft.input?.page;

  // analytics-install installs a tracking script SITEWIDE (GA4/Meta Pixel) —
  // it's not per-page content the way canonical/open-graph genuinely are.
  // Routing it through resolveFile(page) like those types would mean the
  // script only ever fires on whichever one page's file got edited, which
  // defeats the entire point of an "install." It targets the site's one
  // shared layout template instead — the same siteRoot.layoutTemplate
  // html-lang/security-headers already use for other sitewide concerns —
  // so its marker is configured ONCE, via
  // url_file_map.defaults.placements['analytics-install'] (resolveMarkers
  // already falls back to this site-level default when no page/pattern
  // entry exists), not duplicated across every individual page.
  const isSitewideInstall = draft.action_type === 'analytics-install';
  const filePath = isSitewideInstall ? resolveSiteRootFile(site, 'layoutTemplate') : resolveFile(site, page);
  if (!filePath) {
    return isSitewideInstall
      ? { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.layoutTemplate is not configured — set it via `npm run connect-repo` before this can be applied.' }
      : { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}" — add one via \`npm run connect-repo\` before this can be applied.` };
  }

  // SHARED-TEMPLATE SAFETY BACKSTOP.
  //
  // filePath above came from resolveFile — an explicit url_file_map entry, an
  // exact page or a regex pattern. That config can be stale, copy-pasted from
  // another URL, or simply predate the site's route families being
  // understood; page-resolution.js's resolver already rejects a mapping like
  // this at the RECOMMENDATION stage when it can prove the target is a
  // discovered pagination route's own generator template. This is the same
  // check at the APPLY stage — the backstop that makes a mis-mapped
  // `pages[]`/`patterns[]` entry non-fatal to the SITE rather than fatal to
  // every other page that shares the file it points at. isSitewideInstall's
  // siteRoot.layoutTemplate target is exempt by construction (its shared
  // target IS the design), so it never even asks the question.
  //
  // The decision itself lives in action-scope.js's checkSharedTemplateWrite,
  // not here — backend.js's own import graph cannot be exercised under
  // node:test's module mocking (see backend.test.js's header comment), so the
  // actual logic needs to live somewhere unit-testable.
  if (!isSitewideInstall) {
    const refusal = await checkSharedTemplateWrite(site, page, draft.action_type, filePath, {
      discoverRoutes, matchRoute: matchPaginationRoute,
    });
    if (refusal) return { ok: false, ...refusal };
  }

  const markerMap = resolveMarkers(site, page, draft.action_type);
  // For analytics-install specifically, markerMap can be non-null (another
  // provider is configured) while THIS draft's own provider field is still
  // missing — spliceMarkers silently no-ops on a field it was never told
  // about (it only visits markerMap's own keys), which would otherwise look
  // like a successful apply that wrote nothing. Checked explicitly so a
  // second provider's missing config surfaces the same honest error a
  // wholly-unconfigured type gets, not a silent no-op PR.
  const providerField = isSitewideInstall ? ANALYTICS_PROVIDER_FIELDS[draft.content?.provider] : null;
  const markersUsable = markerMap && (!isSitewideInstall || (providerField && providerField in markerMap));
  if (!markersUsable) {
    const { field, marker } = markerConfigExample(draft.action_type, draft.content?.provider);
    const configHint = isSitewideInstall
      ? `add e.g. {"${field}":"${marker}"} to url_file_map.defaults.placements["analytics-install"].markers (once, sitewide)`
      : `add e.g. {"${field}":"${marker}"} to url_file_map.pages[...].placements or .markers`;
    return {
      ok: false, reason: 'no-insertion-marker',
      error: `No markers configured for "${page || '(sitewide)'}" — ${configHint}, and a matching marker in ${filePath}: either <!-- SEOAI:${marker}:START -->...<!-- SEOAI:${marker}:END --> around HTML content, or a trailing # SEOAI:${marker} comment on a single quoted-value line (e.g. front matter).`,
    };
  }

  const branch = beforeRef;
  const file = await getFileContent(site, filePath, branch);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${branch}" — confirm the path in url_file_map is correct.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;

  let mode, inspection;
  if (renderModeOverride) {
    mode = renderModeOverride;
  } else {
    // 'faq' and 'qa-content' additionally check whether the OTHER FAQ
    // writer mechanism (the data-array-content adapter, or each other —
    // both render the same kind of visible accordion block and share one
    // sitewide cap/dedup, see render-inspector.js's INSPECTABLE_ACTION_TYPES)
    // already published a visible FAQ for this exact page — see
    // lib/faq-render-mode.js. Every other marker-merge type keeps calling
    // inspectRenderMode directly, which short-circuits to
    // 'visible'/100/deterministic for anything outside
    // INSPECTABLE_ACTION_TYPES anyway.
    inspection = INSPECTABLE_ACTION_TYPES.includes(draft.action_type)
      ? await decideFaqRenderMode(site, page, file.content, draft.action_type)
      : await inspectRenderMode(file.content, draft.action_type, {});
    if (!inspection.mode || inspection.confidence < CONFIDENCE_THRESHOLD) {
      return {
        ok: false, reason: 'render-mode-uncertain', error: inspection.reason,
        confidence: inspection.confidence, suggestedMode: inspection.mode,
      };
    }
    mode = inspection.mode;
  }

  // Checked only when this action type has a REAL configured componentTemplates
  // entry (the zero-config DEFAULT_* fallback in marker-merge.js makes no
  // claim to match the site's real design, so there's nothing to go stale)
  // and only in 'visible' mode (schema-only publishes no styled markup at
  // all). A failed check (network/infra) fails OPEN — see design-drift.js's
  // own comment on why that's not treated the same as confirmed staleness.
  const componentKey = COMPONENT_TEMPLATE_KEY[draft.action_type];
  const templateEntry = componentKey && site.url_file_map?.siteRoot?.componentTemplates?.[componentKey];
  if (mode === 'visible' && templateEntry) {
    const freshness = await checkTemplateFreshness({ pageUrl: page, templateEntry });
    if (freshness.ok && freshness.stale) {
      return {
        ok: false, reason: 'template-stale',
        error: `This page's live site no longer defines the CSS classes this template expects (${freshness.missingClasses.join(', ')}) — the site's design may have changed since "${componentKey}" was configured. Regenerate it from the site's current design before applying.`,
        missingClasses: freshness.missingClasses, componentKey, actionType: draft.action_type,
      };
    }
  }

  // The design-integrity gate (design-integrity-gate proposal, change 04) —
  // last, because it's the most drastic refusal and every cheaper check
  // above should get a chance to give a more specific reason first.
  //
  // This action type's styled markup either comes from a REAL configured
  // componentTemplates entry (already checked for staleness above) OR —
  // when none is configured — from an ON-THE-FLY projection straight off
  // site.url_file_map.siteRoot.designProfile (buildMergeValues' own
  // templateFor fallback: `configured || projectComponentTemplate(...) ||
  // fallback`, marker-merge.js). BOTH paths trace back to the same captured
  // profile, so this gates on "does a usable profile exist and does it pass
  // automated role verification" — not on whether a componentTemplates entry
  // happens to be configured, and no longer on human sign-off (see
  // checkDesignIntegrityGate's own comment: verifyProfileRoles catches the
  // real incident class — a confirmed role-mismatch — automatically, and a
  // failure here quarantines only THIS draft, never the whole site).
  if (mode === 'visible' && siteHasUsableDesignProfile(site)) {
    const gate = await checkDesignIntegrityGate(site, { actionType: draft.action_type, findingId: draft.finding_id });
    if (!gate.ok) {
      return {
        ok: false, reason: 'design-integrity-failed',
        error: gate.error || `${gate.field} uses classes this site only ever uses for its ${gate.observedAs}.`,
      };
    }
  }

  // 'faq' and 'qa-content' each independently carry their own FAQPage
  // JSON-LD and land in DIFFERENT marker fields (see marker-merge.js), so
  // mode alone (decided above) isn't enough to prevent two separate FAQPage
  // schemas landing on the same page — the mode check downgrades this slot
  // to schema-only when the OTHER slot already went visible, but each slot
  // still emits its OWN schema regardless of mode. Re-scanning the same
  // file.content already fetched above (known engineering issue: validate a
  // schema type doesn't already exist before inserting one).
  const suppressSchema = INSPECTABLE_ACTION_TYPES.includes(draft.action_type) && hasExistingFaqSchema(file.content);
  const built = buildMergeValues(draft.action_type, draft.content, mode, site.url_file_map?.siteRoot?.componentTemplates, site.url_file_map?.siteRoot?.designProfile, { suppressSchema, page });
  if (!built.ok) return { ok: false, reason: 'draft-not-ready', error: built.error };

  // Responsive preview (generators/lib/responsive-preview-gate.js) — every
  // check above is structural/static; this is the one that actually renders
  // the exact content about to publish, in a real browser, at mobile/tablet/
  // desktop widths, and diffs against the live page's own baseline so a
  // pre-existing site defect is never blamed on this draft. Scoped the same
  // as the freshness check above (design-sensitive types, visible mode only)
  // — a schema-only/meta-title splice has nothing rendered to check.
  //
  // Informational by default (RESPONSIVE_GATE_ENFORCE), the same rollout
  // posture checkDesignIntegrityGate used before it started refusing drafts:
  // this needs a real headless-browser round trip against the live site —
  // slower and less battle-tested in production than every static check
  // above it — so it ships watching first, blocking once that's proven out.
  let responsivePreview = null;
  const componentField = MARKER_FIELD_BY_ACTION_TYPE[draft.action_type];
  const marker = componentField && markerMap[componentField];
  if (mode === 'visible' && componentKey && marker && built.values[componentField]) {
    responsivePreview = await checkResponsivePreview({
      pageUrl: page, marker, newContentHtml: built.values[componentField],
    }).catch((err) => ({ ok: false, reason: 'unreachable', error: err.message }));

    if (responsivePreview.ok && responsivePreview.broken && process.env.RESPONSIVE_GATE_ENFORCE === 'true') {
      return {
        ok: false, reason: 'responsive-regression',
        error: `This content breaks the page's layout at a real device width: ${describeResponsiveRegressions(responsivePreview.regressions)}.`,
        regressions: responsivePreview.regressions,
      };
    }
  }

  // Resolves any marker in markerMap that isn't already in the live file —
  // the universal insertion engine (insertion-engine.js's resolveInsertion):
  // learned-strategy-first (strategy-registry.js), then real structural
  // detection, creating whatever's missing inline. `oldContent` below stays
  // the true original fetch, so the diff a reviewer sees includes any
  // marker's own creation alongside the content splice, not just the
  // content — nothing here skips review (this is still the same daily batch
  // PR every other draft goes through), it only removes the separate manual
  // "push an empty marker first" step that used to have to happen before a
  // draft could even reach preview, and the separate stand-alone bootstrap
  // PR that used to have to be merged first.
  const { content: ensuredContent, unresolved } = await resolveInsertion(site, file.content, filePath, markerMap);

  const spliced = spliceMarkers(ensuredContent, markerMap, built.values);
  // Per this platform's daily-batch contract: a field that couldn't be
  // safely resolved must never be spliced with real content and must never
  // reach a PR — reported honestly, by name, with its real reason, rather
  // than a generic "add this marker manually" message. This draft alone is
  // unresolved; nothing here prevents any OTHER draft in the same batch from
  // applying and reaching the PR normally. See insertion-engine.js's
  // buildUnresolvedInsertionFailure for the (independently unit-tested)
  // contract this enforces.
  const failure = buildUnresolvedInsertionFailure(filePath, spliced, unresolved);
  if (failure) return failure;

  return {
    ok: true, filePath, oldContent: file.content, newContent: spliced.newContent, changedRegions: spliced.changedRegions,
    renderMode: mode, renderModeConfidence: inspection?.confidence ?? null, renderModeReason: inspection?.reason ?? null,
    // Carried through even when not enforced (RESPONSIVE_GATE_ENFORCE unset)
    // so a caller/log can see what the check WOULD have refused, during the
    // watch-before-block rollout window — never silently discarded.
    responsivePreview,
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
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : baseBranch(site);
  if (draft.action_type === 'llms-txt') return pushLlmsTxtBranch(site, draft, batchInfo);
  if (draft.action_type === 'sitemap') return pushSitemapBranch(site, draft, batchInfo);
  if (draft.action_type === 'sitemap-removal') return pushSitemapRemovalBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'security-headers') return pushSecurityHeadersBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'compression-nginx') return pushCompressionBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'soft-404-nginx') return pushSoft404NginxBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'redirect-chain-nginx') return pushRedirectChainNginxBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'robots-fix') return pushRobotsFixBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'robots-bootstrap') return pushRobotsBootstrapBranch(site, draft, batchInfo);
  if (draft.action_type === 'redirect-fix') return pushRedirectFixBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'broken-link-fix') return pushBrokenLinkFixBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'duplicate-id-fix') return pushDuplicateIdFixBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'schema-repair') return pushSchemaRepairBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'content-integrity-repair') return pushContentIntegrityBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'sitemap-frontmatter-exclude') return pushSitemapExcludeBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'alt-text') return pushAltTextBranch(site, draft, batchInfo, beforeRef);
  if (draft.action_type === 'blog-image') return pushBlogImageBranch(site, draft, batchInfo, beforeRef);
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
    if (draft.action_type === 'sitemap') {
      const path = resolveSiteRootFile(site, 'sitemap');
      if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.sitemap is not configured.' };
      const file = await getFileContent(site, path, baseBranch(site));
      return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'sitemapXml', content: file?.content || '' }] };
    }
    if (draft.action_type === 'security-headers') return previewLiveSecurityHeaders(site, draft);
    if (draft.action_type === 'compression-nginx') return previewLiveCompression(site, draft);
    if (draft.action_type === 'sitemap-removal') return previewLiveSitemapRemoval(site, draft);
    if (draft.action_type === 'soft-404-nginx') return previewLiveSoft404Nginx(site, draft);
    if (draft.action_type === 'redirect-chain-nginx') return previewLiveRedirectChainNginx(site, draft);
    if (draft.action_type === 'robots-fix') return previewLiveRobotsFix(site, draft);
    if (draft.action_type === 'robots-bootstrap') {
      const path = resolveSiteRootFile(site, 'robotsTxt');
      if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.robotsTxt is not configured.' };
      const file = await getFileContent(site, path, baseBranch(site));
      return { ok: true, filePath: path, live: true, changedRegions: [{ field: 'robotsTxt', content: file?.content || '' }] };
    }
    if (draft.action_type === 'redirect-fix') return previewLiveRedirectFix(site, draft);
    if (draft.action_type === 'broken-link-fix') return previewLiveBrokenLinkFix(site, draft);
    if (draft.action_type === 'duplicate-id-fix') return previewLiveDuplicateIdFix(site, draft);
    if (draft.action_type === 'schema-repair') return previewLiveSchemaRepair(site, draft);
    if (draft.action_type === 'content-integrity-repair') return previewLiveContentIntegrity(site, draft);
    if (draft.action_type === 'sitemap-frontmatter-exclude') return previewLiveSitemapExclude(site, draft);
    if (draft.action_type === 'alt-text') return previewLiveAltText(site, draft);
    if (draft.action_type === 'blog-image') return previewLiveBlogImage(site, draft);
    if (draft.action_type === 'html-lang') return previewLiveHtmlLang(site, draft);
    if (draft.action_type === 'viewport') return previewLiveViewport(site, draft);
    if (MARKER_MERGE_TYPES.has(draft.action_type)) return previewLiveMarkerContent(site, draft);
    return { ok: false, reason: 'merge-strategy-not-implemented', error: `No live view available for "${draft.action_type}" yet.` };
  }

  const batchInfo = await getOrInitBatchBranch(site);
  if (batchInfo.conflicted) return batchBranchConflictError(site, batchInfo);
  const beforeRef = batchInfo.exists ? batchInfo.branchName : baseBranch(site);

  if (draft.action_type === 'llms-txt') {
    const llmsPath = resolveSiteRootFile(site, 'llmsTxt');
    if (!llmsPath) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.llmsTxt is not configured.' };
    const file = await getFileContent(site, llmsPath, beforeRef);
    return { ok: true, filePath: llmsPath, oldContent: file?.content || '', newContent: draft.content.llmsTxt };
  }
  if (draft.action_type === 'sitemap') {
    const path = resolveSiteRootFile(site, 'sitemap');
    if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.sitemap is not configured.' };
    const file = await getFileContent(site, path, beforeRef);
    return { ok: true, filePath: path, oldContent: file?.content || '', newContent: draft.content.sitemapXml };
  }
  if (draft.action_type === 'security-headers') return computeSecurityHeadersMerge(site, draft, beforeRef);
  if (draft.action_type === 'compression-nginx') return computeCompressionMerge(site, draft, beforeRef);
  if (draft.action_type === 'sitemap-removal') return computeSitemapRemovalMerge(site, draft, beforeRef);
  if (draft.action_type === 'soft-404-nginx') return computeSoft404NginxMerge(site, draft, beforeRef);
  if (draft.action_type === 'redirect-chain-nginx') return computeRedirectChainNginxMerge(site, draft, beforeRef);
  if (draft.action_type === 'robots-fix') return computeRobotsFixMerge(site, draft, beforeRef);
  if (draft.action_type === 'robots-bootstrap') {
    const path = resolveSiteRootFile(site, 'robotsTxt');
    if (!path) return { ok: false, reason: 'no-file-mapping', error: 'site.url_file_map.siteRoot.robotsTxt is not configured.' };
    const file = await getFileContent(site, path, beforeRef);
    return { ok: true, filePath: path, oldContent: file?.content || '', newContent: draft.content.robotsTxt };
  }
  if (draft.action_type === 'redirect-fix') return computeRedirectFixMerge(site, draft, beforeRef);
  if (draft.action_type === 'broken-link-fix') return computeBrokenLinkFixMerge(site, draft, beforeRef);
  if (draft.action_type === 'duplicate-id-fix') return computeDuplicateIdFixMerge(site, draft, beforeRef);
  if (draft.action_type === 'schema-repair') return computeSchemaRepairMerge(site, draft, beforeRef);
  if (draft.action_type === 'content-integrity-repair') return computeContentIntegrityMerge(site, draft, beforeRef);
  if (draft.action_type === 'sitemap-frontmatter-exclude') return computeSitemapExcludeMerge(site, draft, beforeRef);
  if (draft.action_type === 'alt-text') return computeAltTextMerge(site, draft, beforeRef);
  if (draft.action_type === 'blog-image') return computeBlogImageMerge(site, draft, beforeRef);
  if (draft.action_type === 'html-lang') return computeHtmlLangMerge(site, draft, beforeRef);
  if (draft.action_type === 'viewport') return computeViewportMerge(site, draft, beforeRef);
  if (MARKER_MERGE_TYPES.has(draft.action_type)) return computeMarkerMerge(site, draft, opts.renderModeOverride, beforeRef);
  return { ok: false, reason: 'merge-strategy-not-implemented', error: `No preview available for "${draft.action_type}" yet.` };
}
