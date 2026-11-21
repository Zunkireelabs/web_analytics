// WHERE PLATFORM CODE REPAIRS MAY GO, in one place, failing CLOSED.
//
// The approval model: agents investigate, fix, test and merge into STAGE on their own; only a person merges into main
// and releases. For the platform's own repo that has to hold even when configuration is wrong, so this module never
// assumes a safe default exists:
//
//   - a repair PR targets the stage branch and ONLY the stage branch. If stage is unset, or is (or is named like)
//     the production branch, there is NO target: nothing is opened, the repair is handed to a person with its evidence.
//     (Previously "no stage branch" meant a PR straight into main, which an auto-merging agent would then have shipped.)
//   - the staging agent may merge a PR only if it targets stage, comes from a self-repair branch, and stage is not
//     production.
//   - GitHub's branch protection on main is the real backstop; this is the application-level refusal in front of it.
export const SELF_REPAIR_BRANCH_PREFIX = 'fix/self-repair-';
const PRODUCTION_NAMES = new Set(['main', 'master', 'production', 'prod', 'release', 'live']);

export function platformBranches(env = process.env) {
  return {
    stage: String(env.PLATFORM_REPO_BASE_BRANCH || 'stage').trim(),
    production: String(env.PLATFORM_PRODUCTION_BRANCH || 'main').trim(),
  };
}

// Is the configured stage branch a branch an agent may target?
export function checkRepairBase(env = process.env) {
  const { stage, production } = platformBranches(env);
  if (!stage) return { ok: false, reason: 'no-stage-configured', error: 'No stage branch is configured for platform repairs, so none will be opened.' };
  if (stage === production || PRODUCTION_NAMES.has(stage.toLowerCase())) {
    return { ok: false, reason: 'unsafe-base-branch', error: `"${stage}" is a production branch. Platform repairs only target a stage branch, so none will be opened.` };
  }
  return { ok: true, stage, production };
}

// May the staging agent merge this PR on its own?
export function checkAutoMergeTarget({ base, headRef }, env = process.env) {
  const target = checkRepairBase(env);
  if (!target.ok) return target;
  if (base !== target.stage) return { ok: false, reason: 'not-stage', error: `That pull request targets "${base}", not the stage branch "${target.stage}". Only stage is merged automatically.` };
  if (!String(headRef || '').startsWith(SELF_REPAIR_BRANCH_PREFIX)) return { ok: false, reason: 'not-a-repair-branch', error: 'Only platform self-repair branches are merged automatically.' };
  return { ok: true, stage: target.stage };
}
