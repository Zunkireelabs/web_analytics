// What the shipping card says at each step. Pure, so the words are tested. `step` comes from the server (lib/ship-flow.js).
export const STEP_ORDER = ['push_branch', 'open_pr', 'merge_stage', 'open_main', 'waiting'];
export const stepIndex = (step) => Math.max(0, STEP_ORDER.indexOf(step));

export function cardFor(state, scope) {
  if (!state?.step) return null;
  const noun = scope === 'content' ? (state.count === 1 ? 'piece of content' : 'pieces of content') : (state.count === 1 ? 'fix' : 'fixes');
  const to = state.hasStage ? ' to stage' : '';
  switch (state.step) {
    case 'push_branch':
      return { title: `All ${state.count} ${noun} ${state.count === 1 ? 'is' : 'are'} approved for today. Should I commit ${state.count === 1 ? 'it' : 'them'} as one commit?`,
        sub: 'If you say yes I commit and push to the branch. Nothing is merged and no pull request is opened until you say so.',
        action: { id: 'push_branch', label: 'Yes, commit and push' }, later: 'Not yet' };
    case 'open_pr':
      return { title: `The commit is on the branch. Open the PR${to}?`,
        sub: state.hasStage ? 'After checks pass I will ask before merging.' : 'Nothing is merged. A person reviews and merges it on GitHub.',
        action: { id: 'open_pr', label: 'Yes, open the PR' }, later: 'Not yet' };
    case 'merge_stage':
      return { title: `The PR to stage (#${state.prNumber}) is open. Merge it?`, sub: 'Just tell me "go ahead" below, or ask me what it changes. One commit · stage only · your live site is not touched.',
        action: { id: 'merge_stage', label: 'Yes, merge to stage' }, later: 'Not yet', link: state.prUrl };
    case 'open_main':
      return { title: 'Merged to stage. Open the PR to main for review?', sub: 'I only open it. A teammate reviews and merges main on GitHub.',
        action: { id: 'open_main', label: 'Open PR to main' }, later: 'Later' };
    case 'waiting':
      return { title: `The PR${state.prNumber ? ` (#${state.prNumber})` : ''} to main is open. Please review it and merge it on GitHub.`, sub: 'It goes live the moment it is merged. This app never merges main, so a person on your team does it. I will remind you if it waits.', info: true, link: state.prUrl, linkLabel: 'Open the PR on GitHub' };
    default: return null;
  }
}

// A refused merge, said plainly. `reason` is the server's code (lib/ship-flow.js), `error` its own sentence.
const PLAIN = {
  'checks-pending': 'The checks are still running. Try again in a minute.',
  'checks-failed': 'A check failed, so it was not merged. Someone needs to look at the pull request.',
  conflicts: 'GitHub says this cannot be merged cleanly yet.',
  'not-open': 'That pull request is no longer open.',
  'github-error': 'GitHub could not be reached just now. Nothing was merged. Try again in a minute.',
  'no-stage': 'This site has no stage branch, so a person merges on GitHub.',
};
export const plainReason = (r) => (r && PLAIN[r.reason]) || r?.error || 'That did not work. Nothing was changed.';
