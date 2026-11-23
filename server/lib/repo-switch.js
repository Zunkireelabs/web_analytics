// WHEN A CONNECTED PROJECT IS MOVED TO A DIFFERENT REPOSITORY (for example Zennly: web-zenly -> zennly-marketplace).
//
// Everything the platform saved about the old repo is wrong for the new one: the URL-to-file map points at files that may not exist or mean something
// else, the design profile and component templates were captured against the old templates, and the layout and marker settings name old paths. Leaving
// them in place makes the agent edit the wrong files, or judge a page against the wrong design, with no sign that anything is stale.
//
// So a move to a different repository:
//   - keeps the old map, whole, under _previousRepo (one generation), so nothing is lost and a person can read exactly what was there;
//   - clears every repo-specific part of the live map (pages, patterns, mounts, areas, defaults, new-content targets, declarations, and the whole siteRoot
//     including the design profile and component templates), keeping only the approvers and the revision counter;
//   - leaves the connect flow's own steps (design re-read, repo discovery, config check) to rebuild a fresh map for the new repo, because the design
//     profile is now missing and the platform re-reads a site that has none.
// The same repository on another branch is NOT a move, and a first connection is not a move. A staff member who passes an explicit map keeps it.

export const repoKey = (site) => (site?.repo_owner && site?.repo_name ? `${site.repo_owner}/${site.repo_name}`.toLowerCase() : null);

/** True only when the project had a repo and now has a different one. */
export function isRepoSwitch(before, after) {
  const a = repoKey(before); const b = repoKey(after);
  return Boolean(a && b && a !== b);
}

const KEEP_KEYS = ['_rev', 'approvers'];

/** The map a project has right after it is moved: empty of anything repo-specific, with the old map kept whole under _previousRepo. */
export function resetMapForNewRepo(map, { from, to, at = new Date().toISOString() }) {
  const old = JSON.parse(JSON.stringify(map || {}));
  delete old._previousRepo; // one generation only
  const next = {};
  for (const k of KEEP_KEYS) if (old[k] !== undefined) next[k] = old[k];
  next._previousRepo = { repo: from, switchedTo: to, switchedAt: at, map: old };
  return next;
}

/**
 * Does the reset, safely: a row-locked write, and a no-op when the map has already been reset for this move (a repeated call). Returns
 * { reset: boolean }.
 */
export async function applyRepoSwitchReset(siteId, { from, to }, { patch }) {
  let did = false;
  await patch(siteId, (map) => {
    if (map?._previousRepo && map._previousRepo.repo === from && map._previousRepo.switchedTo === to) return null;
    did = true;
    return resetMapForNewRepo(map, { from, to });
  });
  return { reset: did };
}
