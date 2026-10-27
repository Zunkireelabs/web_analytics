import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { attachStreamDomains, bareDomain, suggestGoogleProperties, connectionState, GSC_PROPERTY_RE } from './project-connect.js';
import { validateGoal, GOAL_CUSTOM_MAX } from '../../store/workspaces.js';

describe('bareDomain', () => {
  test('strips scheme, www, path, port and sc-domain:', () => {
    assert.equal(bareDomain('https://www.Acme.com/blog?x=1'), 'acme.com');
    assert.equal(bareDomain('sc-domain:acme.com'), 'acme.com');
    assert.equal(bareDomain('acme.com:8080'), 'acme.com');
    assert.equal(bareDomain(''), '');
    assert.equal(bareDomain(null), '');
  });
});

describe('suggestGoogleProperties', () => {
  const searchConsole = [
    { property: 'https://acme.com/', domain: 'acme.com', permission: 'siteOwner' },
    { property: 'sc-domain:acme.com', domain: 'acme.com', permission: 'siteFullUser' },
    { property: 'sc-domain:other.com', domain: 'other.com', permission: 'siteOwner' },
  ];
  const analytics = [{ propertyId: '111', name: 'acme.com' }, { propertyId: '222', name: 'other.com' }];

  test('picks the domain property over the URL-prefix one for the same site', () => {
    assert.deepEqual(suggestGoogleProperties('https://www.acme.com/', { searchConsole, analytics }), { gscProperty: 'sc-domain:acme.com', ga4PropertyId: '111' });
  });
  test('suggests nothing rather than a near miss', () => {
    assert.deepEqual(suggestGoogleProperties('acme.co', { searchConsole, analytics }), { gscProperty: null, ga4PropertyId: null });
    assert.deepEqual(suggestGoogleProperties('', { searchConsole, analytics }), { gscProperty: null, ga4PropertyId: null });
  });
  test('survives a listing that failed (an error object instead of rows)', () => {
    assert.deepEqual(suggestGoogleProperties('acme.com', { searchConsole: { error: 'x' }, analytics: { error: 'y' } }), { gscProperty: null, ga4PropertyId: null });
  });
});

describe('connectionState', () => {
  test('ready only when Google (both halves) and a repo are connected', () => {
    assert.equal(connectionState({}).ready, false);
    assert.equal(connectionState({ gsc_property: 'sc-domain:a.com', ga4_property_id: '1' }).ready, false);
    assert.equal(connectionState({ gsc_property: 'sc-domain:a.com', repo_owner: 'o', repo_name: 'r' }).ready, false);
    const full = connectionState({ gsc_property: 'sc-domain:a.com', ga4_property_id: '1', repo_owner: 'o', repo_name: 'r', github_app_installation_id: 5, onboarded_at: 'now' });
    assert.equal(full.ready, true);
    assert.equal(full.github.repo, 'o/r');
    assert.equal(full.github.installationId, '5');
    assert.equal(full.baseline.done, true);
  });
  test('a repo without an installation reports no installation id (it is on the shared token)', () => {
    assert.equal(connectionState({ repo_owner: 'o', repo_name: 'r' }).github.installationId, null);
  });
});

describe('GSC_PROPERTY_RE', () => {
  test('accepts the two real shapes and rejects anything else', () => {
    assert.ok(GSC_PROPERTY_RE.test('sc-domain:acme.com'));
    assert.ok(GSC_PROPERTY_RE.test('https://acme.com/'));
    assert.ok(!GSC_PROPERTY_RE.test('acme.com'));
  });
});

describe('validateGoal with a custom goal', () => {
  test('a custom goal needs text and ignores growth', () => {
    const ok = validateGoal({ goal: 'custom', customText: '  Fill   our course pages  ', months: 6 });
    assert.deepEqual(ok, { ok: true, goal: { goal: 'custom', goals: ['custom'], growth: 'steady', months: 6, customText: 'Fill our course pages' } });
    assert.equal(validateGoal({ goal: 'custom', customText: '   ', months: 6 }).ok, false);
    assert.equal(validateGoal({ goal: 'custom', months: 6 }).ok, false);
  });
  test('custom text is capped', () => {
    assert.equal(validateGoal({ goal: 'custom', customText: 'x'.repeat(GOAL_CUSTOM_MAX + 1), months: 6 }).ok, false);
    assert.equal(validateGoal({ goal: 'custom', customText: 'x'.repeat(GOAL_CUSTOM_MAX), months: 6 }).ok, true);
  });
  test('a preset goal still needs growth and never carries text', () => {
    assert.equal(validateGoal({ goal: 'enquiries', months: 6 }).ok, false);
    assert.equal(validateGoal({ goal: 'enquiries', growth: 'fast', months: 6, customText: 'ignored' }).goal.customText, null);
    assert.equal(validateGoal({ goal: 'custom', customText: 'x', months: 5 }).ok, false);
  });
});

describe('validateGoal with several goals', () => {
  test('keeps the order ticked, makes the first the primary, and drops repeats', () => {
    const r = validateGoal({ goals: ['ai_answers', 'enquiries', 'ai_answers'], growth: 'fast', months: 6 });
    assert.deepEqual(r, { ok: true, goal: { goal: 'ai_answers', goals: ['ai_answers', 'enquiries'], growth: 'fast', months: 6, customText: null } });
  });
  test('a preset plus your own words needs the words, and still needs a growth choice', () => {
    assert.equal(validateGoal({ goals: ['enquiries', 'custom'], growth: 'fast', months: 6 }).ok, false);
    assert.equal(validateGoal({ goals: ['enquiries', 'custom'], customText: 'x', months: 6 }).ok, false);
    const ok = validateGoal({ goals: ['enquiries', 'custom'], customText: 'Open a second clinic', growth: 'steady', months: 12 });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.goal.goals, ['enquiries', 'custom']);
    assert.equal(ok.goal.customText, 'Open a second clinic');
  });
  test('an empty list, an unknown goal, or a non-array list is refused', () => {
    for (const goals of [[], ['nope'], ['enquiries', 'nope']]) assert.equal(validateGoal({ goals, growth: 'fast', months: 6 }).ok, false);
    assert.equal(validateGoal({ growth: 'fast', months: 6 }).ok, false);
  });
  test('the old single `goal` still works, as a list of one', () => {
    assert.deepEqual(validateGoal({ goal: 'key_rankings', growth: 'steady', months: 3 }).goal.goals, ['key_rankings']);
  });
});

test('a GA4 property gets its real website address from its web data stream', async () => {
  const asked = [];
  const admin = { properties: { dataStreams: { list: async ({ parent }) => {
    asked.push(parent);
    if (parent === 'properties/2') throw new Error('boom');
    return { data: { dataStreams: parent === 'properties/3' ? [] : [{ webStreamData: { defaultUri: 'https://www.zunkireelabs.com/' } }] } };
  } } } };
  const rows = [{ propertyId: '1', name: 'Zunkiree Website' }, { propertyId: '2', name: 'Broken' }, { propertyId: '3', name: 'No stream' }];
  await attachStreamDomains(admin, rows);
  assert.deepEqual(rows.map((r) => r.domain), ['zunkireelabs.com', null, null]);
  // the good answer is kept; the failed one is asked again next time
  asked.length = 0;
  await attachStreamDomains(admin, [{ propertyId: '1', name: 'Zunkiree Website' }, { propertyId: '2', name: 'Broken' }]);
  assert.deepEqual(asked, ['properties/2']);
});

test('the slow part has a time limit: out of budget, remaining properties are left without a domain', async () => {
  let t = 0;
  const admin = { properties: { dataStreams: { list: async () => { t += 3000; return { data: { dataStreams: [{ webStreamData: { defaultUri: 'https://a.com' } }] } }; } } } };
  const rows = Array.from({ length: 20 }, (_, i) => ({ propertyId: String(100 + i), name: `P${i}` }));
  await attachStreamDomains(admin, rows, { now: () => t, budgetMs: 4000 });
  assert.ok(rows.some((r) => r.domain === null), 'some are skipped once the budget is spent');
  assert.ok(rows.every((r) => r.domain !== undefined));
});
