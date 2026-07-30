// Real git merge-conflict marker detection — confirmed root cause of a real
// production incident (2026-07-28): a human resolving a merge conflict on
// GitHub's web UI left literal, unresolved conflict markers ("=======")
// committed directly into zunkireelabs-web's main branch, stacked with a
// duplicate/stale content block. This tool's own marker-merge then fetched
// that already-corrupted file and happily spliced a NEW, correctly-styled
// block on top of it — compounding the damage instead of catching it,
// because nothing here had ever checked whether the "live" file it just
// fetched was itself already broken.
//
// Checked once, right after fetching live file content, in every
// implementer merge function that then splices/injects into it — shared by
// preview() and apply() alike (see backend.js's computeMarkerMerge and
// sibling compute*Merge functions), so a human reviewing a draft's preview
// sees this refusal just as early as an actual apply would.

// RFC-shaped conflict markers: <<<<<<<, =======, >>>>>>> at the start of a
// line, each exactly 7 repeats of its character (git's own convention),
// optionally followed by a ref name (e.g. "<<<<<<< HEAD").
const CONFLICT_MARKER_PATTERN = /^([<=>]{7})(?:\s.*)?$/m;

// Returns null when the content is clean. Returns a real, actionable error
// object when a raw conflict marker is found — never silently proceeds past
// this, and never auto-resolves the conflict itself (that's a real content
// decision only a human, or the real git merge tooling, should make).
export function detectConflictMarkers(content) {
  if (typeof content !== 'string') return null;
  const match = CONFLICT_MARKER_PATTERN.exec(content);
  if (!match) return null;
  const line = content.slice(0, match.index).split('\n').length;
  return {
    ok: false,
    reason: 'conflict-markers',
    error: `This file already contains a raw, unresolved git merge-conflict marker ("${match[1]}") at line ${line} — refusing to build on top of already-corrupted content. Resolve the real conflict in the file directly (check its recent git history for where the marker was introduced) before this draft can be applied.`,
  };
}
