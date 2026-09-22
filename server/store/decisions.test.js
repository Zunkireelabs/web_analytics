import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let issued;
let queryResult;
function fakeQuery(text, params = []) {
  issued.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
  return queryResult;
}

mock.module(resolve('../db.js'), {
  namedExports: { query: (text, params) => fakeQuery(text, params) },
});
const { insertDecision, getDecision, listDecisionsForSite, setDecisionOutcome } = await import('./decisions.js');

beforeEach(() => { issued = []; queryResult = { rows: [] }; });

describe('decisions store', () => {
  test('insertDecision serializes JSONB fields and passes plain scalars through', async () => {
    queryResult = { rows: [{ id: 1 }] };
    await insertDecision(7, {
      situation: 'Keyword gap',
      evidence: [{ source: 'growth-queries', summary: 'x', ref: '1' }],
      rootCause: { hypothesis: 'no page exists', confidence: 0.7, supportingEvidence: ['a'] },
      missingEvidence: ['more data'],
      action: 'new_page',
      actionTarget: { generatorId: 'blog-outline', pageUrl: null },
      rationale: 'no relevant page found',
      alternativesConsidered: [{ action: 'improve_page', whyRejected: 'no candidate page' }],
      confidence: 0.8,
      validationPlan: 'check GSC in 28 days',
    });

    assert.equal(issued.length, 1);
    assert.match(issued[0].sql, /INSERT INTO decisions/);
    const [siteId, situation, evidence, rootCause, missingEvidence, action, actionTarget, rationale, alternatives, confidence, validationPlan] = issued[0].params;
    assert.equal(siteId, 7);
    assert.equal(situation, 'Keyword gap');
    assert.equal(JSON.parse(evidence)[0].source, 'growth-queries');
    assert.equal(JSON.parse(rootCause).hypothesis, 'no page exists');
    assert.deepEqual(JSON.parse(missingEvidence), ['more data']);
    assert.equal(action, 'new_page');
    assert.equal(JSON.parse(actionTarget).generatorId, 'blog-outline');
    assert.equal(rationale, 'no relevant page found');
    assert.equal(JSON.parse(alternatives)[0].action, 'improve_page');
    assert.equal(confidence, 0.8);
    assert.equal(validationPlan, 'check GSC in 28 days');
  });

  test('insertDecision defaults nullable fields correctly when omitted', async () => {
    queryResult = { rows: [{ id: 2 }] };
    await insertDecision(1, { situation: 'x', evidence: [], action: 'do_nothing', rationale: 'no opportunity', confidence: 0.5 });
    const params = issued[0].params;
    assert.equal(params[3], null); // root_cause
    assert.equal(params[6], null); // action_target
    assert.equal(params[10], null); // validation_plan
  });

  test('getDecision returns the first row or null', async () => {
    queryResult = { rows: [{ id: 5, situation: 'x' }] };
    const found = await getDecision(5);
    assert.equal(found.id, 5);
    assert.match(issued[0].sql, /SELECT \* FROM decisions WHERE id = \$1/);

    queryResult = { rows: [] };
    const missing = await getDecision(999);
    assert.equal(missing, null);
  });

  test('listDecisionsForSite filters by action only when provided', async () => {
    queryResult = { rows: [] };
    await listDecisionsForSite(7);
    assert.doesNotMatch(issued[0].sql, /AND action/);

    await listDecisionsForSite(7, { action: 'new_page' });
    assert.match(issued[1].sql, /AND action = \$2/);
    assert.deepEqual(issued[1].params, [7, 'new_page', 50]);
  });

  test('setDecisionOutcome updates status and outcome_ref', async () => {
    queryResult = { rows: [{ id: 3, status: 'shipped' }] };
    const result = await setDecisionOutcome(3, { status: 'shipped', outcomeRef: 'fix-impact:99' });
    assert.equal(result.status, 'shipped');
    assert.deepEqual(issued[0].params, [3, 'shipped', 'fix-impact:99']);
  });
});
