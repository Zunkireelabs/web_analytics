import { resolveFile, resolveAltTextDataSources } from './url-file-map.js';
import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { applyExactMatchPatches, describePatchFailure } from './exact-match-patch.js';
import { searchRepoLocalForStrings } from './repo-local-search.js';
import {
  findRootObjectBounds, findObjectFieldRange, findScalarFieldRange,
  spliceScalarField, insertNewScalarField, assertValidContent,
} from '../adapters/lib/js-data-splice.js';

// Small N — bounds worst-case file-content fetches from the repo-local
// search fallback below, same rationale as backend.js's
// CODE_SEARCH_MAX_CANDIDATES for broken-link-fix's own Layer 2.
const ALT_TEXT_SEARCH_MAX_CANDIDATES = 5;

// Same convention as backend.js's own lastPathSegment (duplicated rather
// than imported — importing from backend.js would be circular, since
// backend.js imports computeAltTextMerge from this file; see
// draft-failure-phrases.js's module comment for why this kind of small,
// well-understood duplication is the accepted tradeoff here over a larger
// shared-utility refactor). The id to match within an altTextDataSources
// dataFile is the page URL's own last path segment.
function lastPathSegment(pageUrl) {
  let path;
  try { path = new URL(pageUrl).pathname; } catch { return null; }
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

// The filename "stem" a build pipeline's own image hashing leaves alone —
// everything up to (not including) the extension and any trailing
// content-hash segment. "/assets/images/data-systems-hero.webp" and the
// rendered "/assets/data-systems-hero-ByIjgOS7.webp" both reduce to
// "data-systems-hero": different directory, different hash, same real
// asset. Deliberately loose (a substring check, not exact-match) since
// exactly how a given build tool hashes/relocates an asset isn't something
// this app can know per-site — loose-but-present beats exact-but-absent
// for a SAFETY check, where the failure mode of "too strict" is a false
// refusal (annoying, always safe) and the failure mode of "too loose" is
// writing wrong content (the thing this check exists to prevent), so any
// genuine doubt should still refuse.
function assetStem(pathOrUrl) {
  if (!pathOrUrl) return null;
  const base = String(pathOrUrl).split('/').pop() || '';
  return base.replace(/\.[a-z0-9]+$/i, '').replace(/-[A-Za-z0-9]{6,}$/, '');
}

// Layer 1.5 (see computeAltTextMerge): writes `alt` into a shared data
// file's `altField` for this page's entry, when the image itself is
// rendered by a shared layout from a data-driven `src` — see
// resolveAltTextDataSources's module comment for the real incident this
// exists for. Mirrors backend.js's applyLinkDataSourceEdit: id-keyed
// (never content-sniffed against the drafted item's `src`, since a
// build-time-hashed output filename has no literal correspondence to the
// source data's own value to match against), refuses rather than guesses
// whenever the shape isn't exactly what's configured.
//
// `item` is the full drafted alt-text item ({ alt, src, originalTag }), not
// just the alt string — needed for the cross-check below. Real incident,
// site 1 (2026-09-11): draft #1608 was generated for the web-development
// page but its item's own `src`/`alt` both plainly described the
// data-systems hero image (an upstream pairing bug in the alt-text
// finder/generator, not in this function) — id-keyed lookup alone would
// have written data-systems' caption onto web-development's entry with no
// error at all. `source.srcField` (the entry's own known-correct image
// field, e.g. "heroImage") lets this layer catch that class of mismatch
// BEFORE writing: if the entry's own configured image and the drafted
// item's image don't share a recognizable filename stem, this is not "the
// page's own hero image" no matter how confidently the draft was worded,
// and refuses rather than trust content-shaped text.
export function applyAltTextDataSourceEdit(content, page, item, source) {
  const id = lastPathSegment(page);
  if (!id) return { ok: false, reason: 'no-file-mapping', error: `Could not derive an id from "${page}".` };

  const format = source.format || 'json-array';
  const rootBounds = findRootObjectBounds(content);
  if (!rootBounds) return { ok: false, reason: 'no-match', error: `Could not find a root object in ${source.dataFile}.` };
  const entryRange = findObjectFieldRange(content, rootBounds, id, format);
  if (!entryRange) return { ok: false, reason: 'no-match', error: `No "${id}" entry found in ${source.dataFile}.` };

  if (source.srcField) {
    const srcRange = findScalarFieldRange(content, entryRange, source.srcField, format);
    const entrySrc = srcRange ? content.slice(srcRange.valueStart + 1, srcRange.valueEnd - 1) : null;
    const entryStem = assetStem(entrySrc);
    const itemStem = assetStem(item.src);
    if (!entryStem || !itemStem || entryStem !== itemStem) {
      return {
        ok: false, reason: 'not-provably-safe',
        error: `"${id}"'s own "${source.srcField}" in ${source.dataFile} is "${entrySrc || '(not set)'}", which doesn't match the drafted image "${item.src}" — this looks like it was detected for a different page. Refusing to write a caption that may describe the wrong image; verify by hand or regenerate the draft.`,
      };
    }
  }

  const alt = item.alt;
  const altField = source.altField;
  const existing = findScalarFieldRange(content, entryRange, altField, format);
  if (existing) {
    const currentValue = content.slice(existing.valueStart + 1, existing.valueEnd - 1);
    if (currentValue.trim()) {
      // Already has real alt text — another draft or a human got there
      // first. Nothing left to apply, not a defect.
      return { ok: false, reason: 'already-resolved', error: `"${id}" already has "${altField}": "${currentValue}" in ${source.dataFile} — nothing left to apply.` };
    }
    const newContent = spliceScalarField(content, entryRange, altField, alt, format);
    if (!newContent) return { ok: false, reason: 'no-match', error: `Could not set "${altField}" on "${id}" in ${source.dataFile}.` };
    const check = assertValidContent(newContent, format);
    if (!check.ok) return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${source.dataFile}'s syntax (${check.error}) — refused to apply.` };
    return { ok: true, newContent };
  }

  const newContent = insertNewScalarField(content, entryRange, altField, alt, format);
  const check = assertValidContent(newContent, format);
  if (!check.ok) return { ok: false, reason: 'invalid-edit', error: `Auto-generated edit would break ${source.dataFile}'s syntax (${check.error}) — refused to apply.` };
  return { ok: true, newContent };
}

// Injects a real alt="" attribute into each image generators/alt-text.js
// drafted a caption for, by finding that image's EXACT original <img> tag
// (originalTag, captured verbatim by page-content.js at detection time) in
// the site's real template source and inserting the attribute into it.
// All-or-nothing per draft (see applyExactMatchPatches): if the source has
// drifted since detection and even one tag's anchor no longer matches
// exactly, no image in this draft gets patched — never a partial write a
// human would have to untangle.
export function withAlt(originalTag, alt) {
  const escaped = alt.replace(/"/g, '&quot;');
  // Self-closing vs. not doesn't matter for the attribute insertion itself —
  // inserted right after the tag name, before any existing attributes, so
  // it reads naturally regardless of what else the tag already has. Keeps
  // the tag name's own original casing (<img> vs <IMG>) — a minimal,
  // single-attribute diff, not an incidental normalization of markup this
  // fix has no business touching.
  return originalTag.replace(/^<(img)\b/i, (_m, tagName) => `<${tagName} alt="${escaped}"`);
}

export async function computeAltTextMerge(site, draft, beforeRef = baseBranch(site)) {
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

  const items = draft.content?.items || [];
  if (!items.length) return { ok: false, reason: 'draft-not-ready', error: 'This draft has no alt-text items.' };

  const edits = items.map((item) => ({ anchor: item.originalTag, replacement: withAlt(item.originalTag, item.alt) }));
  const patched = applyExactMatchPatches(file.content, edits);
  if (patched.ok) {
    return { ok: true, filePath, newContent: patched.content, oldContent: file.content };
  }

  // Layer 1.5: a data-driven image (see resolveAltTextDataSources' module
  // comment) — the page's own file will NEVER contain this src as literal
  // text, by construction, so it's tried before the full-repo Layer 2 scan
  // below (which would burn a whole tarball read only to correctly find
  // nothing). Restricted to single-image drafts on purpose: with 2+ images
  // and one altField per data-source config, there's no reliable way to
  // tell which item maps to which field without guessing — refuses rather
  // than risk writing the wrong image's caption onto the wrong field.
  if (items.length === 1) {
    for (const source of resolveAltTextDataSources(site, page)) {
      const sourceFile = await getFileContent(site, source.dataFile, beforeRef);
      if (!sourceFile || detectConflictMarkers(sourceFile.content)) continue;
      const result = applyAltTextDataSourceEdit(sourceFile.content, page, items[0], source);
      if (result.ok) {
        return { ok: true, filePath: source.dataFile, newContent: result.newContent, oldContent: sourceFile.content };
      }
      // 'no-match' means THIS source's entry didn't apply — worth trying
      // another configured source, or falling through to Layer 2. Every
      // other reason is a definitive verdict on this specific item (already
      // has real alt text, or the src/alt cross-check caught a mismatch)
      // that must surface as-is — silently falling through to Layer 2 would
      // replace a precise, actionable reason with "anchor not found
      // anywhere", exactly the misleading-message problem Layer 2 itself
      // was built to fix. Real incident, site 1 (2026-09-11): without this,
      // draft #1608's mismatch refusal ("doesn't match the drafted image")
      // was getting overwritten by Layer 2's generic failure before a human
      // ever saw the real reason.
      if (result.reason !== 'no-match') return result;
    }
  }

  // Layer 2: the page's own mapped file doesn't contain (all of) these
  // exact <img> tags — real incident, site 1 (2026-09-09 onward): a
  // component-based page's own file can be a thin wrapper with no image
  // markup of its own at all (src/pages/services/data-systems.njk was 440
  // bytes, no <img> anywhere in it), because the hero image actually
  // renders from a shared component the page includes. Every retry hit the
  // identical "anchor no longer found" message for two weeks, worded as if
  // the page's content had changed, when the real problem is that this
  // implementer only ever looked in one file. Same fallback shape as
  // broken-link-fix's own Layer 2 (backend.js/repo-local-search.js): one
  // full-repo scan (cached per site+ref for the run), tried against each
  // real candidate file for the SAME full edit set — a partial match on a
  // wrong file is not evidence, only a file containing every anchor this
  // draft needs is a real candidate.
  let candidates = [];
  try {
    const result = await searchRepoLocalForStrings(site, beforeRef, edits.map((e) => e.anchor), {});
    candidates = result.matches.filter((p) => p !== filePath).slice(0, ALT_TEXT_SEARCH_MAX_CANDIDATES);
  } catch {
    // Missing credential or search outage — fall through to the honest
    // page-file failure below rather than claiming a fallback that never ran.
  }
  for (const candidatePath of candidates) {
    const candidateFile = await getFileContent(site, candidatePath, beforeRef);
    if (!candidateFile || detectConflictMarkers(candidateFile.content)) continue;
    const candidatePatched = applyExactMatchPatches(candidateFile.content, edits);
    if (candidatePatched.ok) {
      return { ok: true, filePath: candidatePath, newContent: candidatePatched.content, oldContent: candidateFile.content };
    }
  }

  return { ok: false, reason: 'source-anchor-not-found', error: describePatchFailure(filePath, patched) };
}

export async function pushAltTextBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeAltTextMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

export async function previewLiveAltText(site, draft) {
  const merged = await computeAltTextMerge(site, draft, baseBranch(site));
  if (!merged.ok) return merged;
  return {
    ok: true,
    filePath: merged.filePath,
    live: true,
    changedRegions: [{ field: 'alt-text', before: merged.oldContent, after: merged.newContent }],
  };
}
