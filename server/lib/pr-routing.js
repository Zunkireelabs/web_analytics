// Where a day's batch pull request is opened for a CLIENT repository (SRANK-47 follow-up, owner decision 2026-11-06).
//
// A client with no stage branch: always straight into its production branch (main).
// A client WITH a stage branch (sites.pr_target_branch): a batch made only of LIGHT edits (tags, alt text: nothing visible) goes straight into main; any batch
// that includes anything else (a landing page, a blog post, a translation, a template or code fix, or a mix) goes into the stage
// branch as ONE pull request, and once a person merges that, the agent opens the stage -> main promotion PR
// (lib/stage-promotion.js). The agent never merges anything.
//
// "Light" means edits that CANNOT change how a page looks: its title and description tags, image alt text, Open Graph and canonical tags (owner decision
// 2026-11-06, narrowed 2026-11-23). Everything that adds or rewrites VISIBLE content (an FAQ, a direct answer, expanded or refreshed text, Q&A, internal links)
// now takes the stage detour too, so a person sees it on the stage site before it can reach production. The narrowing is a direct result of two real
// incidents: unstyled FAQs on MOBILISE and Superrank, both from automatic fixes that had been classed as light and so went straight to main. A type added
// later (a landing page, a blog post, a translation, schema, redirects, sitemap, template and code fixes) is safe by default for the same reason.
export const LIGHT_CONTENT_TYPES = Object.freeze([
  'meta-title', 'alt-text', 'open-graph', 'canonical',
]);
const LIGHT = new Set(LIGHT_CONTENT_TYPES);

/**
 * @param {{ defaultBranch: string, stageBranch?: string|null, actionTypes: string[] }} p
 * @returns {{ base: string, goesToStage: boolean, reason: string }}
 */
export function routeBatch({ defaultBranch, stageBranch = null, actionTypes = [] }) {
  const stage = String(stageBranch || '').trim();
  if (!stage || stage === defaultBranch) return { base: defaultBranch, goesToStage: false, reason: 'no-stage-branch' };
  const types = [...new Set((actionTypes || []).filter(Boolean))];
  // Nothing known about the batch: take the careful route rather than assume it is light.
  if (types.length === 0) return { base: stage, goesToStage: true, reason: 'unknown-contents' };
  const heavy = types.filter((t) => !LIGHT.has(t));
  if (heavy.length === 0) return { base: defaultBranch, goesToStage: false, reason: 'light-content-only' };
  return { base: stage, goesToStage: true, reason: `needs-review-first: ${heavy.join(', ')}` };
}
