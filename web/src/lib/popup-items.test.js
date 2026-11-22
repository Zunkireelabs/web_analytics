import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsForPopup } from './popup-items.js';

const items = [{ key: 'approval:stage-pr:12', prNumber: 12 }, { key: 'approval:content', count: 2 }];
test('the stage PR is shown once: hidden from the list while the shipping card asks to merge it', () => {
  assert.deepEqual(itemsForPopup(items, { fixes: { step: 'merge_stage' } }).map((i) => i.key), ['approval:content']);
  assert.deepEqual(itemsForPopup(items, { content: { step: 'merge_stage' } }).map((i) => i.key), ['approval:content']);
});
test('with no card asking, the PR stays in the list so the popup still says it is waiting', () => {
  assert.equal(itemsForPopup(items, { fixes: { step: 'open_main' } }).length, 2);
  assert.equal(itemsForPopup(items, null).length, 2);
  assert.deepEqual(itemsForPopup(undefined, null), []);
});

import { greeting } from './agent-greeting.js';
test('the bubble says plainly when something has been waiting for days, and otherwise says what it said before', () => {
  assert.match(greeting([{ key: 'approval:stage-pr:12', prNumber: 12, overdue: true, ageDays: 4 }]), /1 thing has been waiting for your OK for 4 days/);
  assert.match(greeting([{ key: 'approval:fixes', count: 2 }]), /2 fixes are left for your approval/);
});
