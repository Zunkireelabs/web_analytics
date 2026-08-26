import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchingHandler } from './worker.js';

// Confirms the one thing that would otherwise be a silent regression: a
// 'capability-repair' job (a real repo EDIT) must reach the native
// capability-repair handler (server/design-agent/native-repair-handler.js),
// not the live-analysis handler, which has no idea what to do with an edit
// job and would misreport it as a bad design-profile input instead of
// running the repair.
describe('createDispatchingHandler — routes by job.params.mode, not a single handler for everything', () => {
  test('capability-repair mode is routed to the native capability-repair handler', async () => {
    // createDispatchingHandler forwards its options to BOTH inner
    // handlers. getSiteByIdFn/checkoutIntoSandboxFn are the native
    // capability-repair handler's own dependencies — a valid site (with a
    // repo configured) plus a failing checkout proves this job reached
    // THAT handler specifically (stage 'repo_checkout'), not the
    // live-analysis one (which would fail at 'input_validation' instead,
    // since it has no pageUrl and no concept of a checkout dependency at
    // all).
    const dispatch = createDispatchingHandler({
      getSiteByIdFn: async () => ({ id: 1, repo_owner: 'acme', repo_name: 'acme-web', repo_default_branch: 'stage' }),
      checkoutIntoSandboxFn: async () => { throw new Error('fake: no real repo checkout in this unit test'); },
    });
    await assert.rejects(
      () => dispatch({
        id: 1, site_id: 1,
        params: { mode: 'capability-repair', payload: { generatorId: 'faq', templatePath: 'src/a.njk', dataFilePath: 'src/_data/a.js' } },
      }),
      (err) => { assert.equal(err.stage, 'repo_checkout'); return true; },
    );
  });

  test('a capability-repair job missing required payload fields fails input_validation before ever reaching site lookup', async () => {
    let touched = false;
    const dispatch = createDispatchingHandler({
      getSiteByIdFn: async () => { touched = true; return null; },
    });
    await assert.rejects(
      () => dispatch({ id: 1, site_id: 1, params: { mode: 'capability-repair', payload: { generatorId: 'faq' } } }),
      (err) => { assert.equal(err.stage, 'input_validation'); return true; },
    );
    assert.equal(touched, false, 'missing templatePath/dataFilePath must short-circuit before any site lookup');
  });

  test('design-profile mode (and any mode other than capability-repair) reaches the live-analysis handler', async () => {
    const dispatch = createDispatchingHandler();
    await assert.rejects(
      () => dispatch({ id: 2, site_id: 1, params: { mode: 'design-profile' } }),
      (err) => { assert.equal(err.stage, 'input_validation'); return true; },
      'no pageUrl on a design-profile job should hit the live-analysis handler\'s own input validation',
    );
  });
});
