import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from './agent-greeting.js';

describe('the small line at the top of the agent popup', () => {
  test('approvals left, fixes and content together', () => {
    assert.equal(greeting([{ key: 'approval:fixes', count: 4 }, { key: 'approval:content', count: 3 }]), 'Hey, 4 fixes and 3 pieces of content are left for your approval.');
  });
  test('one of one reads naturally', () => {
    assert.equal(greeting([{ key: 'approval:fixes', count: 1 }]), 'Hey, 1 fix is left for your approval.');
    assert.equal(greeting([{ key: 'approval:content', count: 1 }]), 'Hey, 1 piece of content is left for your approval.');
  });
  test('a change ready to go live counts as an approval too', () => {
    assert.match(greeting([{ key: 'approval:fixes', count: 2 }, { key: 'approval:main:244' }]), /2 fixes and 1 change ready to go live are left for your approval\./);
  });
  test('everything approved but a shipping step is still to answer', () => {
    assert.equal(greeting([], { fixes: { step: 'push_branch' }, content: null }), 'Hey, everything is approved. One step is left before it goes live.');
  });
  test('approvals still left win over the shipping step, so it never says "everything is approved" too early', () => {
    assert.match(greeting([{ key: 'approval:fixes', count: 1 }], { fixes: { step: 'push_branch' } }), /left for your approval/);
  });
  test('issues and decisions are named as needing attention', () => {
    assert.equal(greeting([{ key: 'issue:agent-failures', count: 2 }]), 'Hey, 2 things need your attention.');
    assert.equal(greeting([{ key: 'decision:7', count: 1 }]), 'Hey, 1 thing needs your attention.');
  });
  test('only a PR waiting for a person to merge', () => {
    assert.equal(greeting([], { fixes: { step: 'waiting' } }), 'Hey, a pull request is waiting for someone to merge it on GitHub.');
  });
  test('nothing at all gives no line, so the normal greeting shows', () => {
    assert.equal(greeting([], { fixes: null, content: { step: null } }), null);
    assert.equal(greeting([]), null);
  });
});
