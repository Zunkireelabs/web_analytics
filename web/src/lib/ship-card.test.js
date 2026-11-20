import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cardFor, stepIndex, plainReason } from './ship-card.js';

describe('the shipping card words', () => {
  test('no step means no card', () => { assert.equal(cardFor({ step: null }, 'fixes'), null); assert.equal(cardFor(null, 'fixes'), null); });
  test('all decided and approved: it asks to commit and push first, saying no PR is opened yet', () => {
    const c = cardFor({ step: 'push_branch', count: 3, hasStage: true }, 'fixes');
    assert.match(c.title, /All 3 fixes are approved for today\. Should I commit them as one commit\?/);
    assert.match(c.sub, /no pull request is opened until you say so/);
    assert.equal(c.action.id, 'push_branch');
  });
  test('the commit is on the branch: then it asks to open the PR, to stage when there is one', () => {
    const c = cardFor({ step: 'open_pr', count: 3, hasStage: true }, 'fixes');
    assert.match(c.title, /The commit is on the branch\. Open the PR to stage\?/);
    assert.equal(c.action.id, 'open_pr');
  });
  test('content and singular are worded properly', () => {
    assert.match(cardFor({ step: 'push_branch', count: 1 }, 'content').title, /All 1 piece of content is approved for today\. Should I commit it/);
    assert.match(cardFor({ step: 'push_branch', count: 1 }, 'fixes').title, /All 1 fix is approved/);
  });
  test('a site with no stage never mentions stage or offers a merge', () => {
    const c = cardFor({ step: 'open_pr', count: 2, hasStage: false }, 'fixes');
    assert.doesNotMatch(c.title, /stage/);
    assert.match(c.sub, /person reviews and merges it on GitHub/);
  });
  test('merge to stage names the PR; opening main only opens', () => {
    assert.match(cardFor({ step: 'merge_stage', prNumber: 244 }, 'fixes').title, /#244/);
    const m = cardFor({ step: 'open_main' }, 'fixes');
    assert.match(m.sub, /I only open it/);
    assert.equal(m.action.id, 'open_main');
  });
  test('waiting for review is information only: no button, so there is no way to merge main from here', () => {
    const c = cardFor({ step: 'waiting', prNumber: 245, prUrl: 'u' }, 'fixes');
    assert.equal(c.info, true);
    assert.equal(c.action, undefined);
    assert.match(c.title, /review it and merge it on GitHub/);
    assert.match(c.sub, /never merges main/);
  });
  test('steps are ordered, and a refused merge is said plainly', () => {
    assert.deepEqual(['push_branch', 'open_pr', 'merge_stage', 'open_main', 'waiting'].map(stepIndex), [0, 1, 2, 3, 4]);
    assert.match(plainReason({ reason: 'checks-pending' }), /still running/);
    assert.match(plainReason({ reason: 'github-error' }), /could not be reached/);
    assert.equal(plainReason({ reason: 'weird', error: 'Specific words' }), 'Specific words');
  });
});
