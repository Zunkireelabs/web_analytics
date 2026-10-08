import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateEvents, eventKeyFor, isAlreadyBeingHandled, isGateEnforcing,
  COOLDOWN_DAYS, OPERATIONAL_TYPES,
} from './alert-gate.js';

// The gate's whole job is a decision, so unlike detect.js (whose cooldown is
// a bare DB fact) every rule here is reachable with injected deps and is
// tested directly — a suppression gate whose rules are only exercised in
// production is exactly the kind of thing that goes quiet without anyone
// noticing.

// Delivers nothing recently, drafts nothing, records into an array.
function deps(overrides = {}) {
  const recorded = [];
  return {
    recorded,
    opts: {
      hasRecentDelivered: async () => false,
      loadDraftedFindingIds: async () => new Set(),
      recordDecisions: async (_siteId, decisions) => { recorded.push(...decisions); },
      enforcing: true,
      ...overrides,
    },
  };
}

const criticalIssue = (findingId, body = 'something is broken') => ({
  type: 'critical-issue', severity: 'high', title: 'New critical issue detected', body, findingIds: [findingId],
});

describe('eventKeyFor', () => {
  test('uses the finding ids, so the same finding re-detected gets the same key', () => {
    assert.equal(eventKeyFor(criticalIssue('f1')), 'f1');
    assert.equal(eventKeyFor(criticalIssue('f1', 'reworded body')), 'f1');
  });

  test('different findings of the same type get different keys', () => {
    assert.notEqual(eventKeyFor(criticalIssue('f1')), eventKeyFor(criticalIssue('f2')));
  });

  test('is order-insensitive — a reordered group is not a new group', () => {
    const a = { type: 'critical-issues-group', findingIds: ['f1', 'f2', 'f3'] };
    const b = { type: 'critical-issues-group', findingIds: ['f3', 'f1', 'f2'] };
    assert.equal(eventKeyFor(a), eventKeyFor(b));
  });

  test('metric events with no findings key on the type alone — one health score per site', () => {
    assert.equal(eventKeyFor({ type: 'health-drop', findingIds: [] }), 'health-drop');
  });

  test('an insight id is used when present, so one forecast is one identity', () => {
    assert.equal(eventKeyFor({ type: 'predictive-risk', insightId: 42 }), 'insight:42');
  });

  test('falls back to hashing its own text when there is no id at all', () => {
    const k = eventKeyFor({ type: 'predictive-risk', title: 'Traffic at risk', body: 'x' });
    assert.match(k, /^text:[0-9a-f]{16}$/);
    assert.equal(k, eventKeyFor({ type: 'predictive-risk', title: 'Traffic at risk', body: 'x' }));
    assert.notEqual(k, eventKeyFor({ type: 'predictive-risk', title: 'Traffic at risk', body: 'y' }));
  });

  test('null and empty finding ids are ignored rather than forming a key', () => {
    assert.equal(eventKeyFor({ type: 'health-drop', findingIds: [null, undefined] }), 'health-drop');
  });
});

describe('isAlreadyBeingHandled', () => {
  test('true only when every finding already has a live draft', () => {
    assert.equal(isAlreadyBeingHandled(criticalIssue('f1'), new Set(['f1'])), true);
    assert.equal(isAlreadyBeingHandled({ type: 'x', findingIds: ['f1', 'f2'] }, new Set(['f1'])), false);
  });

  test('false for an event with no findings — an empty set is not vacuously handled', () => {
    assert.equal(isAlreadyBeingHandled({ type: 'health-drop', findingIds: [] }, new Set()), false);
  });
});

describe('gateEvents — cooldowns', () => {
  test('a first alert is delivered and recorded as delivered', async () => {
    const { recorded, opts } = deps();
    const { deliver, suppressed } = await gateEvents(1, [criticalIssue('f1')], opts);

    assert.equal(deliver.length, 1);
    assert.equal(suppressed.length, 0);
    assert.deepEqual(recorded.map((r) => r.decision), ['delivered']);
    assert.equal(recorded[0].eventKey, 'f1');
  });

  test('the same alert inside its cooldown is suppressed with the window in the reason', async () => {
    const { recorded, opts } = deps({ hasRecentDelivered: async () => true });
    const { deliver, suppressed } = await gateEvents(1, [criticalIssue('f1')], opts);

    assert.equal(deliver.length, 0);
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].reason, 'cooldown:3d');
    assert.equal(recorded[0].decision, 'suppressed');
  });

  test('the cooldown is keyed per event, not per type: a DIFFERENT finding still gets through', async () => {
    // This is the central property. A type-only cooldown would mute every
    // new critical issue for three days after the first one.
    const alreadyToldAbout = new Set(['f1']);
    const { opts } = deps({
      hasRecentDelivered: async (_siteId, _type, eventKey) => alreadyToldAbout.has(eventKey),
    });
    const { deliver, suppressed } = await gateEvents(1, [criticalIssue('f1'), criticalIssue('f2')], opts);

    assert.equal(deliver.length, 1);
    assert.equal(deliver[0].findingIds[0], 'f2');
    assert.equal(suppressed.length, 1);
  });

  test('predictive-risk is silent on the second night for the same insight', async () => {
    // The nightly Python push re-sends this for the whole life of an
    // unresolved insight; 14 days per insight identity is the fix.
    assert.equal(COOLDOWN_DAYS['predictive-risk'], 14);
    const seen = new Set();
    const opts = deps({
      hasRecentDelivered: async (_s, type, key) => seen.has(`${type}:${key}`),
      recordDecisions: async (_s, ds) => {
        for (const d of ds) if (d.decision === 'delivered') seen.add(`${d.eventType}:${d.eventKey}`);
      },
    }).opts;
    const event = { type: 'predictive-risk', severity: 'high', title: 'Risk', body: 'b', insightId: 7 };

    const night1 = await gateEvents(1, [event], opts);
    const night2 = await gateEvents(1, [event], opts);

    assert.equal(night1.deliver.length, 1, 'the first night must get through');
    assert.equal(night2.deliver.length, 0, 'the second night is the repeat');
    assert.equal(night2.suppressed[0].reason, 'cooldown:14d');
  });

  test('a suppressed event does not start its own cooldown', async () => {
    // Only 'delivered' rows satisfy a cooldown. If a suppression counted,
    // the first one would keep renewing itself and mute the alert forever.
    const { recorded, opts } = deps({ hasRecentDelivered: async () => true });
    await gateEvents(1, [criticalIssue('f1')], opts);
    assert.equal(recorded.filter((r) => r.decision === 'delivered').length, 0);
  });

  test('a type with no configured cooldown is never cooldown-suppressed', async () => {
    const calls = [];
    const { opts } = deps({
      hasRecentDelivered: async (...args) => { calls.push(args); return true; },
    });
    const { deliver } = await gateEvents(1, [{ type: 'some-future-type', findingIds: [] }], opts);

    assert.equal(deliver.length, 1);
    assert.equal(calls.length, 0, 'no cooldown configured means the window is not even consulted');
  });
});

describe('gateEvents — actionability', () => {
  test('an event whose findings are all already drafted is suppressed', async () => {
    const { opts } = deps({ loadDraftedFindingIds: async () => new Set(['f1']) });
    const { deliver, suppressed } = await gateEvents(1, [criticalIssue('f1')], opts);

    assert.equal(deliver.length, 0);
    assert.equal(suppressed[0].reason, 'already-drafted');
  });

  test('a partially drafted group still alerts', async () => {
    const { opts } = deps({ loadDraftedFindingIds: async () => new Set(['f1']) });
    const event = { type: 'critical-issues-group', severity: 'high', findingIds: ['f1', 'f2'] };
    const { deliver } = await gateEvents(1, [event], opts);

    assert.equal(deliver.length, 1);
  });

  test('operational alarms are NEVER actionability-suppressed', async () => {
    // Recorded lesson: threshold alarms exist because a background job fell
    // short and nobody heard. For ship-stall the ABSENCE of work is the
    // alarm, so "nothing is drafted" must not be read as "nothing to say".
    assert.ok(OPERATIONAL_TYPES.has('ship-stall'));
    const { opts } = deps({ loadDraftedFindingIds: async () => new Set(['f1']) });
    const { deliver } = await gateEvents(1, [{ type: 'ship-stall', severity: 'high', findingIds: ['f1'] }], opts);

    assert.equal(deliver.length, 1);
  });

  test('operational alarms still respect their cooldown', async () => {
    const { opts } = deps({ hasRecentDelivered: async () => true });
    const { deliver, suppressed } = await gateEvents(1, [{ type: 'ship-stall', findingIds: [] }], opts);

    assert.equal(deliver.length, 0);
    assert.equal(suppressed[0].reason, 'cooldown:1d');
  });

  test('the drafted-findings lookup is skipped entirely for an all-operational batch', async () => {
    let called = false;
    const { opts } = deps({ loadDraftedFindingIds: async () => { called = true; return new Set(); } });
    await gateEvents(1, [{ type: 'ship-stall', findingIds: [] }], opts);
    assert.equal(called, false);
  });

  test('a failing drafted-findings lookup alerts rather than going quiet', async () => {
    const { opts } = deps({ loadDraftedFindingIds: async () => { throw new Error('db down'); } });
    const { deliver } = await gateEvents(1, [criticalIssue('f1')], opts);
    assert.equal(deliver.length, 1);
  });
});

describe('gateEvents — batch handling and log-only mode', () => {
  test('two events with the same identity collapse within one batch', async () => {
    const { opts } = deps();
    const { deliver, suppressed } = await gateEvents(1, [criticalIssue('f1'), criticalIssue('f1')], opts);

    assert.equal(deliver.length, 1);
    assert.equal(suppressed[0].reason, 'duplicate-in-batch');
  });

  test('log-only mode delivers everything but records what it would have done', async () => {
    const { recorded, opts } = deps({ enforcing: false, hasRecentDelivered: async () => true });
    const { deliver, suppressed, enforcing } = await gateEvents(1, [criticalIssue('f1')], opts);

    assert.equal(enforcing, false);
    assert.equal(deliver.length, 1, 'nothing is withheld until the flag is on');
    assert.equal(suppressed.length, 0);
    assert.deepEqual(recorded.map((r) => r.decision), ['would-suppress', 'delivered']);
    assert.equal(recorded[0].reason, 'cooldown:3d');
    // Recorded as delivered too, because it genuinely was — otherwise the
    // cooldown read would misreport what the user actually received.
    assert.equal(recorded[1].reason, 'log-only-mode');
  });

  test('an empty batch does no work at all', async () => {
    let recordCalled = false;
    const { opts } = deps({ recordDecisions: async () => { recordCalled = true; } });
    const { deliver, suppressed } = await gateEvents(1, [], opts);

    assert.deepEqual(deliver, []);
    assert.deepEqual(suppressed, []);
    assert.equal(recordCalled, false);
  });

  test('a failing decision write does not sink the batch', async () => {
    const { opts } = deps({ recordDecisions: async () => { throw new Error('write failed'); } });
    const { deliver } = await gateEvents(1, [criticalIssue('f1')], opts);
    assert.equal(deliver.length, 1);
  });

  test('severity is passed through untouched — the gate decides who to tell, not how bad it is', async () => {
    const { recorded, opts } = deps();
    await gateEvents(1, [criticalIssue('f1')], opts);
    assert.equal(recorded[0].severity, 'high');
  });
});

describe('isGateEnforcing', () => {
  test('off by default, so the deploy is behaviourally inert', () => {
    assert.equal(isGateEnforcing({}), false);
  });

  test('on only for the exact string "true"', () => {
    assert.equal(isGateEnforcing({ ALERT_GATE_ENABLED: 'true' }), true);
    assert.equal(isGateEnforcing({ ALERT_GATE_ENABLED: '1' }), false);
    assert.equal(isGateEnforcing({ ALERT_GATE_ENABLED: 'yes' }), false);
  });
});
