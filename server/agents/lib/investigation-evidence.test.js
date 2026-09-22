import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let callResult;
let callError;
let lastCall;
mock.module(resolve('../../lib/data-analyst-client.js'), {
  namedExports: {
    callDataAnalystAgent: async (path, opts) => {
      lastCall = { path, opts };
      if (callError) throw callError;
      return callResult;
    },
  },
});
const { fetchInvestigationEvidence, toEvidence } = await import('./investigation-evidence.js');

describe('fetchInvestigationEvidence', () => {
  test('maps investigations into Evidence shape', async () => {
    callError = null;
    callResult = {
      investigations: [{
        id: 5, metric_key: 'clicks', dimension_type: 'page', dimension_value: '/pricing',
        insight_type: 'anomaly', severity: 'high', priority: 'high', status: 'evidence_collected',
        summary: 'Clicks dropped 20%', root_cause_text: 'A canonical change was detected',
        forecast_outlook: null, confidence: 0.75, missing_evidence: ['GA4 conversion data'], evidence: { delta: -0.2 },
      }],
    };

    const evidence = await fetchInvestigationEvidence(7);

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].source, 'data-analyst-investigation');
    assert.equal(evidence[0].ref, 'investigation:5');
    assert.match(evidence[0].summary, /Clicks dropped 20%/);
    assert.match(evidence[0].summary, /Root cause: A canonical change was detected/);
    assert.equal(evidence[0].meta.investigationId, 5);
    assert.deepEqual(evidence[0].meta.missingEvidence, ['GA4 conversion data']);
    assert.deepEqual(lastCall.path, '/clients/7/investigations');
  });

  test('returns an empty array (never throws) when the Data Analyst service is unreachable', async () => {
    callError = Object.assign(new Error('Data Analyst Agent is unreachable right now'), { status: 502 });
    const evidence = await fetchInvestigationEvidence(7);
    assert.deepEqual(evidence, []);
  });

  test('handles a non-array investigations field gracefully', async () => {
    callError = null;
    callResult = {};
    const evidence = await fetchInvestigationEvidence(7);
    assert.deepEqual(evidence, []);
  });
});

describe('toEvidence', () => {
  test('falls back to a generic summary when no summary/root_cause/forecast fields are present', () => {
    const evidence = toEvidence({ id: 1, insight_type: 'trend', metric_key: 'impressions' });
    assert.equal(evidence.summary, 'trend investigation on impressions');
  });
});
