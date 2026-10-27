import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteStagesBeforeLive } from './fix-verification.js';

test('a site that merges into stage first is detected', () => {
  assert.equal(siteStagesBeforeLive({ pr_target_branch: 'stage' }), true);
  assert.equal(siteStagesBeforeLive({ pr_target_branch: 'stage', repo_default_branch: 'main' }), true);
});
test('no stage branch, or stage equal to the default, is not staging', () => {
  assert.equal(siteStagesBeforeLive({}), false);
  assert.equal(siteStagesBeforeLive({ pr_target_branch: 'main' }), false);
  assert.equal(siteStagesBeforeLive({ pr_target_branch: 'develop', repo_default_branch: 'develop' }), false);
});
