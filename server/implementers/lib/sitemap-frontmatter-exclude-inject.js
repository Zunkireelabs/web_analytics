// The counterpart to sitemap-removal-inject.js for the OTHER real sitemap
// shape this platform onboards: a build-time-generated sitemap.xml (a
// Nunjucks/Eleventy/Liquid/Handlebars template that loops over every page
// at build time — e.g. zunkireelabs-web's src/sitemap.njk) rather than a
// hand-maintained static XML file. sitemap-removal's exact-match
// <url><loc>...</loc></url> search is meaningless against a templated
// source — it contains ONE literal <url> block with {{ }} placeholders,
// never a real URL — so it always safely refuses there without ever
// actually excluding anything. The real per-page lever for a templated
// sitemap is whatever front-matter flag its own loop already checks
// (zunkireelabs-web's sitemap.njk: `{%- if page.url and not
// page.data.excludeFromSitemap %}`) — this sets that flag on the ONE
// page's own source file, verified per-site (see sites.url_file_map.
// siteRoot.sitemapExcludeField — never assumed for any site whose template
// hasn't been read and confirmed to actually honor that field name).
//
// Self-correcting the same way sitemap-removal is: nothing here touches
// the underlying noindex/robots/canonical signal, only the sitemap
// listing; if that signal is ever reversed, this page's own front matter
// would need a separate human/agent action to flip the flag back — no
// automatic re-inclusion exists yet, same honest limitation sitemap-
// removal's own comment already accepts for its half of this problem.
import { resolveFile } from './url-file-map.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';

// Anchored to the very start of the file (^) so this can never match a
// horizontal-rule `---` the page's own body content happens to contain
// further down — only a file's real leading front-matter delimiter.
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function buildFrontMatterExcludeEdit(content, field) {
  const match = FRONT_MATTER_RE.exec(content);
  if (!match) {
    return {
      ok: false, reason: 'no-front-matter',
      error: 'This page\'s source file has no YAML front-matter block (---...---) at its start, so there is nowhere to set the sitemap-exclusion flag on it.',
    };
  }
  const block = match[0];
  const body = match[1];
  const eol = block.includes('\r\n') ? '\r\n' : '\n';

  // Already excluded — a stale finding (the exclusion already shipped, or
  // a human set it by hand), not something to re-apply.
  if (new RegExp(`^${field}\\s*:`, 'm').test(body)) {
    return { ok: false, reason: 'already-resolved', error: `"${field}" is already set in this page's front matter — nothing left to change.` };
  }

  const newBlock = `---${eol}${body}${eol}${field}: true${eol}---${eol}`;
  return { ok: true, anchor: block, replacement: newBlock };
}

export async function computeSitemapExcludeMerge(site, draft, beforeRef = baseBranch(site)) {
  const page = draft.content?.page;
  const field = draft.content?.field;
  if (!field) return { ok: false, reason: 'draft-not-ready', error: 'This draft has no sitemap-exclusion field name — it may predate this fix type.' };

  const filePath = resolveFile(site, page);
  if (!filePath) {
    return { ok: false, reason: 'no-file-mapping', error: `No url_file_map entry matches "${page || '(no page)'}".` };
  }
  const file = await getFileContent(site, filePath, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}".` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;

  const edit = buildFrontMatterExcludeEdit(file.content, field);
  if (!edit.ok) return edit;

  const patched = applyExactMatchPatches(file.content, [{ anchor: edit.anchor, replacement: edit.replacement }]);
  if (!patched.ok) {
    return { ok: false, reason: 'source-anchor-not-found', error: describePatchFailure(filePath, patched) };
  }
  return { ok: true, filePath, newContent: patched.content, oldContent: file.content };
}

export async function pushSitemapExcludeBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeSitemapExcludeMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

export async function previewLiveSitemapExclude(site, draft) {
  const merged = await computeSitemapExcludeMerge(site, draft, baseBranch(site));
  if (!merged.ok) return merged;
  return {
    ok: true,
    filePath: merged.filePath,
    live: true,
    changedRegions: [{ field: draft.content?.field || 'excludeFromSitemap', before: merged.oldContent, after: merged.newContent }],
  };
}
