import { useEffect, useRef } from 'react';

// "Connect with GitHub / PostHog" in a NEW TAB, so the SuperRank page the person started from stays where it was.
//
// How the two tabs talk: the provider sends the new tab back to our callback, which redirects it to /connected
// (pages/ConnectedTab.jsx) with the outcome in the query string. That page asks, over a BroadcastChannel, whether a
// SuperRank tab is waiting for this connection. The waiting tab answers and receives the outcome; the new tab then says
// "connected, close this tab". If no tab answers (the person closed it, or the browser blocked the new tab and we fell
// back to the same tab), /connected forwards to the old /workspace?... address, so nothing is ever lost.
//
// No window.opener is used: the new tab is opened, then cut off from this one (opener = null) before it leaves for the
// provider, so the provider's page can never reach back into ours.

export const CONNECT_CHANNEL = 'superrank-connect';

// What to tell someone whose GitHub screen ended without a connection (the callback's ?gherror=).
export const GITHUB_ERRORS = {
  cancelled: 'You closed the GitHub screen before finishing, so nothing was connected.',
  expired: 'That GitHub sign-in took too long or did not start here. Please try again.',
  denied: 'Your account cannot connect GitHub for this project.',
  exchange_failed: 'GitHub did not accept that sign-in. Please try again.',
  github_failed: 'GitHub could not be reached just now. Please try again.',
};

const channel = () => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CONNECT_CHANNEL));

// Open a blank tab NOW (inside the click, so pop-up blockers allow it), then send it to the address `getUrl` resolves.
// Returns 'tab' when the new tab is used, 'same' when the browser refused a new tab and this tab went instead.
export async function openConnectTab(getUrl) {
  let tab = null;
  try { tab = window.open('', '_blank'); } catch { tab = null; }
  let url;
  try {
    url = await getUrl();
  } catch (err) {
    try { tab?.close(); } catch { /* already gone */ }
    throw err;
  }
  if (!tab || tab.closed) {
    window.location.assign(url);
    return 'same';
  }
  try { tab.opener = null; } catch { /* some browsers make it read-only; the channel does not need it */ }
  tab.location.href = url;
  return 'tab';
}

// While `kind` ('github' | 'posthog') is being connected in another tab, answer that tab and receive its outcome.
// `onDone(params)` gets the callback's query parameters as a plain object (e.g. { github: 'connected' } or
// { gherror: 'cancelled' }). Also re-checks when the person comes back to this tab, in case the browser has no
// BroadcastChannel: `onFocus` is called then.
export function useConnectTab(kind, waiting, { onDone, onFocus } = {}) {
  const done = useRef(onDone);
  const focus = useRef(onFocus);
  done.current = onDone;
  focus.current = onFocus;
  useEffect(() => {
    if (!waiting) return undefined;
    const ch = channel();
    if (ch) {
      ch.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.kind !== kind) return;
        if (msg.type === 'ping') ch.postMessage({ type: 'pong', kind, id: msg.id });
        if (msg.type === 'done') done.current?.(msg.params || {});
      };
    }
    const onVisible = () => { if (document.visibilityState === 'visible') focus.current?.(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { ch?.close(); document.removeEventListener('visibilitychange', onVisible); };
  }, [kind, waiting]);
}

// Used by /connected: is a SuperRank tab waiting for `kind`? Resolves true once one answers, false after `ms`.
export function findWaitingTab(kind, ms = 600) {
  const ch = channel();
  if (!ch) return Promise.resolve({ found: false, send: () => {} });
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const finish = (found) => {
      clearTimeout(timer);
      ch.onmessage = null;
      if (!found) { ch.close(); resolve({ found, send: () => {} }); return; }
      resolve({ found, send: (params) => { ch.postMessage({ type: 'done', kind, params }); setTimeout(() => ch.close(), 50); } });
    };
    const timer = setTimeout(() => finish(false), ms);
    ch.onmessage = (e) => { const m = e.data || {}; if (m.type === 'pong' && m.kind === kind && m.id === id) finish(true); };
    ch.postMessage({ type: 'ping', kind, id });
  });
}
