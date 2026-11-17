import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchMissing } from './projects.js';

// The real messages these checks see. Live 2026-11-17: a broken SuperRank App key showed as
// 'There is no "main" branch' although main existed.
test('only a GitHub 404/422 on the branch counts as a missing branch', () => {
  assert.equal(branchMissing(new Error('getBranchSha failed (404): {"message":"Not Found"}')), true);
  assert.equal(branchMissing(new Error('getBranchSha failed (422): {"message":"Reference does not exist"}')), true);
});

test('a broken App key, no access or GitHub being down is not a missing branch', () => {
  assert.equal(branchMissing(new Error('error:1E08010C:DECODER routines::unsupported')), false);
  assert.equal(branchMissing(new Error('Could not mint a GitHub App installation token for installation 182851133 (HTTP 401).')), false);
  assert.equal(branchMissing(new Error('getBranchSha failed (403): {"message":"Resource not accessible by integration"}')), false);
  assert.equal(branchMissing(new Error('getBranchSha failed (502): Bad Gateway')), false);
  assert.equal(branchMissing(new Error('GitHub request timed out after 15000ms: GET /repos/x/y/git/ref/heads/main')), false);
  assert.equal(branchMissing(undefined), false);
});
