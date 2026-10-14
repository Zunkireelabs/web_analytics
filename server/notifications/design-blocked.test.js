import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { designBlockedEvent, notifyDesignBlocked, DESIGN_BLOCKED_COOLDOWN_DAYS } from './design-blocked.js';
import { eventKeyFor, COOLDOWN_DAYS } from './alert-gate.js';

const site = { id: 5, name: 'Admizz' };

describe('designBlockedEvent', () => {
  test('is medium severity, says nothing is broken live, and names the reason in plain words', () => {
    const e = designBlockedEvent(site, { reason: 'render-deviation', actionType: 'blog-outline' });
    assert.equal(e.severity, 'medium');
    assert.match(e.title, /Admizz/);
    assert.match(e.body, /Nothing is broken on the live site/);
    assert.match(e.body, /measure differently/);
  });
  test('the identity is the SITE, so two different drafts are one episode in the alert gate too', () => {
    const a = designBlockedEvent(site, { reason: 'design-incomplete', actionType: 'blog-outline' });
    const b = designBlockedEvent(site, { reason: 'render-deviation', actionType: 'landing-page' });
    assert.equal(eventKeyFor(a), eventKeyFor(b));
    assert.equal(eventKeyFor(a), 'insight:design-blocked:5');
    assert.equal(COOLDOWN_DAYS['design-blocked'], DESIGN_BLOCKED_COOLDOWN_DAYS);
  });
  test('an unknown reason still produces a sensible message', () => {
    assert.match(designBlockedEvent(site, { reason: 'zzz' }).body, /could not be matched/);
  });
});

describe('notifyDesignBlocked', () => {
  test('the first block in an episode sends exactly one notification', async () => {
    const sent = [];
    const r = await notifyDesignBlocked(site, { reason: 'design-incomplete', actionType: 'faq' }, { hasRecent: async () => false, deliver: async (id, ev) => { sent.push([id, ev]); } });
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 5);
    assert.equal(sent[0][1][0].type, 'design-blocked');
  });
  test('a second block inside the window is the same episode — nothing sent', async () => {
    let delivered = 0;
    const r = await notifyDesignBlocked(site, {}, { hasRecent: async () => true, deliver: async () => { delivered++; } });
    assert.deepEqual([r.sent, r.reason, delivered], [false, 'same-episode', 0]);
  });
  test('the cooldown is asked for this type and window, independent of the alert-gate flag', async () => {
    let asked;
    await notifyDesignBlocked(site, {}, { hasRecent: async (id, type, days) => { asked = [id, type, days]; return true; }, deliver: async () => {} });
    assert.deepEqual(asked, [5, 'design-blocked', 7]);
  });
  test('never throws into the ship path', async () => {
    const r = await notifyDesignBlocked(site, {}, { hasRecent: async () => { throw new Error('db'); }, deliver: async () => {} });
    assert.deepEqual([r.sent, r.reason], [false, 'error']);
  });
});
