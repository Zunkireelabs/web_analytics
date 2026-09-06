import { getFileContent } from '../../github/client.js';
import { baseBranch, pushDraftBranch } from './github-ops.js';
import { detectConflictMarkers } from './conflict-marker-check.js';
import { hasImageField, insertFrontMatterFields } from '../../generators/lib/blog-frontmatter.js';

// The generator already knows the EXACT file (from the repo-tree scan the
// detector did — agents/blog-image.js), so this splices by filePath
// directly rather than resolving one from a `page` URL the way every other
// backend.js merge does. Still the same exact-match-or-refuse safety
// contract as schema-repair-inject.js/content-integrity-inject.js: content
// is re-fetched live, right before patching, and re-checks draft.content.mode
// against the post's CURRENT state — 'missing' refuses if an image already
// showed up some other way since detection (a human edit, a different
// agent, or having merged an earlier day's own batch PR); 'duplicate'
// refuses if the image it meant to replace is already gone.
// insertFrontMatterFields upserts rather than only appends, so a
// 'duplicate' repair replaces the existing featuredImage/Alt/Credit trio in
// place instead of adding a second, conflicting one.
export async function computeBlogImageMerge(site, draft, beforeRef = baseBranch(site)) {
  const filePath = draft.content?.filePath;
  if (!filePath) return { ok: false, reason: 'draft-not-ready', error: 'This draft has no target file path.' };

  const file = await getFileContent(site, filePath, beforeRef);
  if (!file) {
    return { ok: false, reason: 'file-not-found', error: `${filePath} does not exist on branch "${beforeRef}" — it may have moved or been deleted since this draft was generated.` };
  }
  const conflict = detectConflictMarkers(file.content);
  if (conflict) return conflict;

  const mode = draft.content?.mode || 'missing';
  const hasImage = hasImageField(file.content);
  if (mode === 'missing' && hasImage) {
    return { ok: false, reason: 'already-has-image', error: `${filePath} already has a featured image — this post may have been updated since this draft was generated.` };
  }
  if (mode !== 'missing' && !hasImage) {
    return { ok: false, reason: 'no-longer-duplicate', error: `${filePath} no longer has a featured image to replace — this post may have been updated since this draft was generated.` };
  }

  const newContent = insertFrontMatterFields(file.content, [
    ['featuredImage', draft.content.imageUrl],
    ['featuredImageAlt', draft.content.imageAlt],
    ['featuredImageCredit', draft.content.imageCredit],
  ]);
  if (newContent === file.content) {
    return { ok: false, reason: 'draft-not-ready', error: 'This draft has no image fields to insert.' };
  }
  return { ok: true, filePath, newContent, oldContent: file.content };
}

export async function pushBlogImageBranch(site, draft, batchInfo, beforeRef) {
  const merged = await computeBlogImageMerge(site, draft, beforeRef);
  if (!merged.ok) return merged;
  return pushDraftBranch(site, draft, [{ path: merged.filePath, content: merged.newContent }], batchInfo);
}

export async function previewLiveBlogImage(site, draft) {
  const merged = await computeBlogImageMerge(site, draft, baseBranch(site));
  if (!merged.ok) return merged;
  return {
    ok: true,
    filePath: merged.filePath,
    live: true,
    changedRegions: [{ field: 'featuredImage', before: merged.oldContent, after: merged.newContent }],
  };
}
