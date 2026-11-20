import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { emitAgentStart, emitAgentDone, runningAgentsFor, subscribeActivity } from './activity-bus.js';

describe('activity bus: what is running now', () => {
  test('a started agent is running until it is done', () => {
    emitAgentStart('site-a', 'keywords');
    assert.deepEqual(runningAgentsFor('site-a').map((r) => r.agentId), ['keywords']);
    emitAgentDone('site-a', 'keywords', { status: 'ok' });
    assert.deepEqual(runningAgentsFor('site-a'), []);
  });
  test('one site never sees another site running', () => {
    emitAgentStart('site-b', 'authority');
    assert.deepEqual(runningAgentsFor('site-c'), []);
    emitAgentDone('site-b', 'authority', { status: 'ok' });
  });
  test('a failed run also stops counting as running', () => {
    emitAgentStart('site-d', 'geo-signals');
    emitAgentDone('site-d', 'geo-signals', { status: 'error' });
    assert.deepEqual(runningAgentsFor('site-d'), []);
  });
  test('events still reach only the subscribed site', () => {
    const seen = [];
    const off = subscribeActivity('site-e', (e) => seen.push(e.type));
    emitAgentStart('site-e', 'x'); emitAgentStart('site-f', 'x'); emitAgentDone('site-e', 'x', { status: 'ok' });
    off();
    assert.deepEqual(seen, ['start', 'done']);
    emitAgentDone('site-f', 'x', { status: 'ok' });
  });
});
