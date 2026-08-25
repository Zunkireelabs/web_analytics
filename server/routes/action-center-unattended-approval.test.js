import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { approveAndPublishDraftUnattended } from './action-center.js';

// approveAndPublishDraftUnattended exists specifically to close the
// strand-and-hide gap confirmed live on site #1 (2026-08-25): 31 drafts
// stuck at 'submitted_for_approval' because approveAndPublishDraft threw
// (render-mode rejection, failed preview, rendering-gate refusal) and
// nothing ever reverted the row, so getDraftedFindingIds() treated them as
// permanently "already handled." These tests exercise exactly that
// failure/recovery path, injecting fakes for approveFn/abandonFn rather than
// a real DB — same convention as repairSiteTemplates/queueDesignAgentDerivationForSite.
describe('approveAndPublishDraftUnattended', () => {
  test('a successful approve is returned untouched, and abandonFn is never called', async () => {
    let abandonCalls = 0;
    const result = await approveAndPublishDraftUnattended(1, 42, { userId: null }, {
      approveFn: async () => ({ id: 42, branch_name: 'auto/42', pr_number: 7 }),
      abandonFn: async () => { abandonCalls++; },
    });
    assert.deepEqual(result, { id: 42, branch_name: 'auto/42', pr_number: 7 });
    assert.equal(abandonCalls, 0);
  });

  test('a thrown rejection abandons the draft with a reason, then rethrows the original error', async () => {
    const abandonCalls = [];
    const err = Object.assign(new Error('render mode is uncertain'), { status: 422, userFacing: true, reason: 'render-mode-uncertain' });
    await assert.rejects(
      approveAndPublishDraftUnattended(1, 42, { userId: null }, {
        approveFn: async () => { throw err; },
        abandonFn: async (siteId, draftId, reason) => { abandonCalls.push({ siteId, draftId, reason }); },
      }),
      /render mode is uncertain/,
    );
    assert.equal(abandonCalls.length, 1);
    assert.equal(abandonCalls[0].siteId, 1);
    assert.equal(abandonCalls[0].draftId, 42);
    assert.match(abandonCalls[0].reason, /render mode is uncertain/);
  });

  test('a failure to abandon the draft never masks the original error', async () => {
    const err = new Error('rendering gate rejected the insertion point');
    await assert.rejects(
      approveAndPublishDraftUnattended(1, 42, {}, {
        approveFn: async () => { throw err; },
        abandonFn: async () => { throw new Error('db unreachable'); },
      }),
      /rendering gate rejected the insertion point/,
    );
  });
});
