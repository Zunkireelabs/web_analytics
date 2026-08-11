import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildComponentTemplateProposal, buildComponentTemplateProposalsFromJob } from './component-template-proposal.js';

// checkTemplateFreshness's real implementation does live HTTP fetches — it's
// injectable here (checkTemplateFreshnessFn) exactly so these tests never
// touch the network, same stub-the-boundary discipline as the rest of this
// suite (worker.test.js/openhands-handler.test.js).

describe('buildComponentTemplateProposal', () => {
  test('rejects an unknown action type', async () => {
    const result = await buildComponentTemplateProposal({ actionType: 'not-a-real-type', template: { wrapper: '{{ROWS}}', row: 'x' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /has no component-template concept/);
  });

  test('rejects a missing/empty template', async () => {
    const result = await buildComponentTemplateProposal({ actionType: 'faq', template: null });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not report a template/);
  });

  test('rejects a template missing required placeholder tokens, and records it to agent_fix_memory', async () => {
    let recorded = null;
    const recordFixOutcomeFn = async (args) => { recorded = args; return 'memory-id-1'; };
    const result = await buildComponentTemplateProposal({
      actionType: 'faq',
      template: { wrapper: '<div>{{ROWS}}</div>', row: '<p>{{QUESTION}}</p>' }, // missing {{ANSWER}}
      siteId: 42,
      recordFixOutcomeFn,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /missing required placeholder/);
    assert.match(result.error, /ANSWER/);
    assert.equal(recorded.generatorId, 'design-agent-component-templates');
    assert.equal(recorded.siteId, 42);
    assert.equal(recorded.problemSignature, 'missing-placeholders:faq');
  });

  test('a memory-write failure while recording a rejected proposal never blocks the caller', async () => {
    const recordFixOutcomeFn = async () => { throw new Error('DB is down'); };
    const result = await buildComponentTemplateProposal({
      actionType: 'faq',
      template: { wrapper: '<div>{{ROWS}}</div>', row: '<p>{{QUESTION}}</p>' }, // missing {{ANSWER}}
      siteId: 42,
      recordFixOutcomeFn,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /missing required placeholder/);
  });

  test('accepts a structurally valid template with no pageUrl (no class-freshness check run)', async () => {
    const result = await buildComponentTemplateProposal({
      actionType: 'faq',
      template: { wrapper: '<div class="faq-wrap">{{ROWS}}</div>', row: '<div class="faq-row"><p>{{QUESTION}}</p><p>{{ANSWER}}</p></div>' },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingClasses, []);
  });

  test('surfaces missingClasses from the freshness check as a warning, not a rejection', async () => {
    const checkTemplateFreshnessFn = async () => ({ ok: true, stale: true, missingClasses: ['faq-wrap', 'faq-row'], checkedClasses: ['faq-wrap', 'faq-row'] });
    const result = await buildComponentTemplateProposal({
      actionType: 'faq',
      template: { wrapper: '<div class="faq-wrap">{{ROWS}}</div>', row: '<div class="faq-row">{{QUESTION}}{{ANSWER}}</div>' },
      pageUrl: 'https://example.com/faq',
      checkTemplateFreshnessFn,
    });
    assert.equal(result.ok, true, 'a class-freshness warning must not hard-reject the proposal — the human /confirm step is the real gate');
    assert.deepEqual(result.missingClasses, ['faq-wrap', 'faq-row']);
  });

  test('fails open (no rejection, empty missingClasses) when the freshness check itself fails (network/infra)', async () => {
    const checkTemplateFreshnessFn = async () => ({ ok: false, error: 'Could not fetch the page.' });
    const result = await buildComponentTemplateProposal({
      actionType: 'faq',
      template: { wrapper: '<div class="faq-wrap">{{ROWS}}</div>', row: '<div>{{QUESTION}}{{ANSWER}}</div>' },
      pageUrl: 'https://example.com/faq',
      checkTemplateFreshnessFn,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingClasses, []);
  });
});

describe('buildComponentTemplateProposalsFromJob', () => {
  test('builds one proposal per action type in job.result.componentTemplates, and threads the job\'s site_id through to the recorded lesson', async () => {
    const job = {
      site_id: 7,
      result: {
        componentTemplates: {
          faq: { wrapper: '{{ROWS}}', row: '{{QUESTION}}{{ANSWER}}' },
          'expand-content': { wrapper: '{{ROWS}}', row: '{{HEADING}}' }, // missing {{BODY}} — should fail its own entry, not the others
        },
      },
    };
    let recorded = null;
    const recordFixOutcomeFn = async (args) => { recorded = args; return 'memory-id-2'; };
    const proposals = await buildComponentTemplateProposalsFromJob(job, { recordFixOutcomeFn });
    assert.equal(proposals.faq.ok, true);
    assert.equal(proposals['expand-content'].ok, false);
    assert.match(proposals['expand-content'].error, /BODY/);
    assert.equal(recorded.siteId, 7);
    assert.equal(recorded.problemSignature, 'missing-placeholders:expand-content');
  });

  test('returns an empty object for a job with no componentTemplates result', async () => {
    assert.deepEqual(await buildComponentTemplateProposalsFromJob({ result: null }), {});
    assert.deepEqual(await buildComponentTemplateProposalsFromJob({}), {});
  });
});
