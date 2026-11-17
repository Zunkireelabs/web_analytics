import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openConnectTab, findWaitingTab, CONNECT_CHANNEL } from './connect-tab.js';

// GitHub / PostHog open in a new tab and report back over a BroadcastChannel (Node has one too, so this is the real thing).

describe('findWaitingTab', () => {
  test('nobody waiting: resolves not found, so /connected falls back to the Workspace page', async () => {
    const r = await findWaitingTab('github', 50);
    assert.equal(r.found, false);
  });

  test('a waiting tab answers, and receives the outcome; another kind does not', async () => {
    const waiting = new BroadcastChannel(CONNECT_CHANNEL);
    const got = [];
    waiting.onmessage = (e) => {
      const m = e.data;
      if (m.kind !== 'github') return; // a PostHog wait must not answer a GitHub tab
      if (m.type === 'ping') waiting.postMessage({ type: 'pong', kind: 'github', id: m.id });
      if (m.type === 'done') got.push(m.params);
    };
    const other = await findWaitingTab('posthog', 80);
    assert.equal(other.found, false);
    const r = await findWaitingTab('github', 500);
    assert.equal(r.found, true);
    r.send({ finish: '9', github: 'connected' });
    await new Promise((res) => setTimeout(res, 80));
    waiting.close();
    assert.deepEqual(got, [{ finish: '9', github: 'connected' }]);
  });
});

describe('openConnectTab', () => {
  const saved = globalThis.window;
  afterEach(() => { globalThis.window = saved; });

  test('opens the tab inside the click, then cuts it off from this page and sends it to the provider', async () => {
    const tab = { closed: false, opener: 'this page', location: { href: 'about:blank' } };
    globalThis.window = { open: () => tab, location: { assign: () => assert.fail('must not leave this page') } };
    const how = await openConnectTab(async () => 'https://github.com/login/oauth/authorize?x=1');
    assert.equal(how, 'tab');
    assert.equal(tab.opener, null, 'the provider page can never reach back into ours');
    assert.equal(tab.location.href, 'https://github.com/login/oauth/authorize?x=1');
  });

  test('a blocked pop-up falls back to this tab, the way it worked before', async () => {
    let went = null;
    globalThis.window = { open: () => null, location: { assign: (u) => { went = u; } } };
    assert.equal(await openConnectTab(async () => 'https://github.com/x'), 'same');
    assert.equal(went, 'https://github.com/x');
  });

  test('when the address cannot be fetched, the empty tab is closed and the error reaches the screen', async () => {
    let closed = false;
    globalThis.window = { open: () => ({ closed: false, close: () => { closed = true; }, location: {} }), location: { assign: () => {} } };
    await assert.rejects(openConnectTab(async () => { throw new Error('GitHub sign-in is not set up on this server yet.'); }), /not set up/);
    assert.equal(closed, true);
  });
});
