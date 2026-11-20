import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { approveDraftOnly } from './action-center.js';

// The client's Approve records the approval and nothing else: no branch, no pull request. These tests inject fakes, so they run
// without a database or GitHub, and every fake that could touch GitHub throws if it is reached.
const forbidden = () => { throw new Error('approveDraftOnly must never push a branch or open a pull request'); };
const draft = (status) => ({ id: 7, site_id: 1, status });

describe('approveDraftOnly', () => {
  test('a draft waiting for approval is validated and approved, and returned', async () => {
    const calls = [];
    const out = await approveDraftOnly(1, 7, { userId: 4 }, {
      getDraftFn: async () => draft('submitted_for_approval'),
      submitFn: forbidden,
      validateFn: async () => { calls.push('validate'); return { draft: draft('submitted_for_approval') }; },
      approveFn: async (siteId, id, userId) => { calls.push(`approve:${userId}`); return { ...draft('approved'), approved_by: userId }; },
    });
    assert.deepEqual(calls, ['validate', 'approve:4']);
    assert.equal(out.status, 'approved');
  });

  test('a fresh draft is submitted first, so one press is enough', async () => {
    const calls = [];
    await approveDraftOnly(1, 7, { userId: 4 }, {
      getDraftFn: async () => draft('draft'),
      submitFn: async () => { calls.push('submit'); return draft('submitted_for_approval'); },
      validateFn: async () => { calls.push('validate'); return { draft: draft('submitted_for_approval') }; },
      approveFn: async () => { calls.push('approve'); return draft('approved'); },
    });
    assert.deepEqual(calls, ['submit', 'validate', 'approve']);
  });

  test('a draft that is not there, or cannot be submitted, is a 404 and approves nothing', async () => {
    await assert.rejects(approveDraftOnly(1, 7, {}, { getDraftFn: async () => null, approveFn: forbidden }), (e) => e.status === 404);
    await assert.rejects(approveDraftOnly(1, 7, {}, { getDraftFn: async () => draft('edited'), submitFn: async () => null, approveFn: forbidden }), (e) => e.status === 404);
  });

  test('a draft that fails the quality check is not approved', async () => {
    await assert.rejects(approveDraftOnly(1, 7, {}, {
      getDraftFn: async () => draft('submitted_for_approval'),
      validateFn: async () => { const e = new Error('Quality Gate failed'); e.status = 422; throw e; },
      approveFn: forbidden,
    }), (e) => e.status === 422);
  });

  test('if the approval step returns nothing, it is a 404, not a silent success', async () => {
    await assert.rejects(approveDraftOnly(1, 7, {}, {
      getDraftFn: async () => draft('submitted_for_approval'),
      validateFn: async () => ({ draft: draft('submitted_for_approval') }),
      approveFn: async () => null,
    }), (e) => e.status === 404);
  });
});
