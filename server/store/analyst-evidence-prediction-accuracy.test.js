import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// analystPredictionAccuracyByGenerator (2026-09 Data Analyst audit finding
// #3) — analyst-outcome.js already recorded predictionConfirmed per
// recommendation, but nothing grouped it by GENERATOR, the key
// generator-learning.js's shared learning map needs.

let rows;
let issued;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith('SELECT r.recommendation_type')) return { rows };
  throw new Error(`analyst-evidence-prediction-accuracy.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), { namedExports: { query: (text, params) => fakeQuery(text, params) } });
const { analystPredictionAccuracyByGenerator } = await import('./analyst-evidence.js');

beforeEach(() => { issued = []; rows = []; });

describe('analystPredictionAccuracyByGenerator', () => {
  test('groups by generator (recommendation_type), scoped to the site and only measured outcomes', async () => {
    rows = [];
    await analystPredictionAccuracyByGenerator(5);
    assert.match(issued[0].sql, /GROUP BY r\.recommendation_type/);
    assert.match(issued[0].sql, /ae\.outcome IS NOT NULL/);
    assert.match(issued[0].sql, /predictionConfirmed/);
    assert.deepEqual(issued[0].params, [5]);
  });

  test('returns measured/confirmed counts per generator as given', async () => {
    rows = [{ generator_id: 'qa-content', measured: 4, confirmed: 3 }, { generator_id: 'meta-title', measured: 2, confirmed: 0 }];
    const result = await analystPredictionAccuracyByGenerator(1);
    assert.deepEqual(result, rows);
  });

  test('no measured outcomes at all: an empty result, never fabricated rows', async () => {
    rows = [];
    const result = await analystPredictionAccuracyByGenerator(1);
    assert.deepEqual(result, []);
  });
});
