import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://x:x@localhost:1/x';
const { detectStageBranch } = await import('./stage-branch.js');

const mk = (existing) => {
  const saved = [];
  return { saved, deps: {
    getBranchSha: async (_s, b) => { if (!existing.includes(b)) throw new Error('404'); return 'sha'; },
    updateSiteRepoConfig: async (x) => { saved.push(x); },
  } };
};
const site = { id: 5, repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main', pr_target_branch: null };

test('a repo with a stage branch gets it recorded', async () => {
  const { saved, deps } = mk(['main', 'stage']);
  assert.deepEqual(await detectStageBranch(site, { deps }), { changed: true, branch: 'stage' });
  assert.deepEqual(saved, [{ siteId: 5, prTargetBranch: 'stage' }]);
});
test('a person\'s setting is never overwritten', async () => {
  const { saved, deps } = mk(['stage']);
  const r = await detectStageBranch({ ...site, pr_target_branch: 'qa' }, { deps });
  assert.equal(r.changed, false); assert.equal(saved.length, 0);
});
test('no stage branch, no repo, or stage equal to the default branch changes nothing', async () => {
  for (const [s, existing] of [[site, ['main']], [{ ...site, repo_owner: null }, ['stage']], [{ ...site, repo_default_branch: 'stage' }, ['stage']]]) {
    const { saved, deps } = mk(existing);
    assert.equal((await detectStageBranch(s, { deps })).changed, false); assert.equal(saved.length, 0);
  }
});
test('staging is accepted when there is no stage', async () => {
  const { saved, deps } = mk(['main', 'staging']);
  assert.equal((await detectStageBranch(site, { deps })).branch, 'staging'); assert.equal(saved[0].prTargetBranch, 'staging');
});
