import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let issued;
let rowsToReturn;

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), {
  namedExports: {
    query: (text, params) => {
      issued.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
      return { rows: rowsToReturn };
    },
  },
});
const { getLatestAgentRunSummaries, getLatestAgentRuns, getLatestFindings } = await import('./agent-runs.js');

beforeEach(() => { issued = []; rowsToReturn = []; });

// Egress fix (2026-10-01): the agent status list and the staleness context
// re-read each agent's whole latest run — `facts`/`narrative`/`input`, ~26KB a
// row — on every call, just to learn a status and a timestamp.
describe('getLatestAgentRunSummaries', () => {
  test('never selects the bulky payload columns', async () => {
    await getLatestAgentRunSummaries(3, ['authority', 'ai-visibility']);
    const { sql } = issued[0];
    const selectList = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM agent_runs'));
    // `facts` may appear ONLY inside the extracted scalar expressions, never as a bare column.
    assert.doesNotMatch(selectList, /(^|[\s,])facts([\s,]|$)/);
    assert.doesNotMatch(selectList, /\bnarrative\b/);
    assert.doesNotMatch(selectList, /(^|[\s,])input([\s,]|$)/);
  });

  test('extracts exactly the three values its callers read out of facts, in SQL', async () => {
    await getLatestAgentRunSummaries(3, ['authority']);
    const { sql } = issued[0];
    assert.match(sql, /jsonb_array_length\(facts->'findings'\)[\s\S]*AS finding_count/);
    assert.match(sql, /facts->'authorityScore' AS authority_score/);
    assert.match(sql, /facts->'siteScore'->'overall' AS site_score_overall/);
  });

  test('keeps the same latest-run-per-agent selection and agent_version (fresh-runs filters on it)', async () => {
    await getLatestAgentRunSummaries(3, ['a', 'b']);
    const { sql, params } = issued[0];
    assert.match(sql, /SELECT DISTINCT ON \(agent_id\) id, agent_id, agent_version, status, error, took_ms, created_at/);
    assert.match(sql, /WHERE site_id = \$1 AND agent_id = ANY\(\$2\) ORDER BY agent_id, created_at DESC/);
    assert.deepEqual(params, [3, ['a', 'b']]);
  });

  test('the full reader is unchanged — findings/copilot/insights still get facts, narrative and input', async () => {
    await getLatestAgentRuns(3, ['a']);
    assert.match(issued[0].sql, /id, agent_id, agent_version, input, status, facts, narrative, error, took_ms, created_at/);
  });
});

// getLatestFindings serves recommendations, command-center, growth-report and
// insights, and only ever maps findings / checkedPages / linkCrawl.checkedPages
// out of `facts` and start / end out of `input`. Verified identical to the old
// whole-row read on every site in production (77 runs, deep-equal).
describe('getLatestFindings reads only the fields it maps', () => {
  test('selects extracted keys, never the whole facts/input blobs', async () => {
    await getLatestFindings(3, ['security-headers']);
    const { sql, params } = issued[0];
    // `AS facts` / `AS input` are the output aliases (same names the mapper reads); drop them
    // so the check only sees real column references.
    const selectList = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM agent_runs')).replace(/AS (facts|input)\b/g, '');
    assert.doesNotMatch(selectList, /(^|[\s,])facts([\s,]|$)/, 'no bare facts column');
    assert.doesNotMatch(selectList, /(^|[\s,])input([\s,]|$)/, 'no bare input column');
    assert.match(selectList, /facts->'findings'/);
    assert.match(selectList, /facts->'checkedPages'/);
    assert.match(selectList, /facts->'linkCrawl'->'checkedPages'/);
    assert.match(selectList, /input->'start'/);
    assert.match(selectList, /input->'end'/);
    assert.deepEqual(params, [3, ['security-headers']]);
  });

  test('maps rows exactly as before, including the null/empty fallbacks', async () => {
    rowsToReturn = [
      { agent_id: 'technical-seo', agent_version: 2, status: 'ok', narrative: 'n', created_at: 'T',
        input: { start: '2026-09-01', end: '2026-09-28' },
        facts: { findings: [{ id: 'f1' }], checkedPages: ['/a'], linkCrawl: { checkedPages: ['/b'] } } },
      // facts column was NULL in the DB: jsonb_build_object yields null members, not a missing object
      { agent_id: 'sitemap', agent_version: 1, status: 'ok', narrative: null, created_at: 'T2',
        input: { start: null, end: null },
        facts: { findings: null, checkedPages: null, linkCrawl: { checkedPages: null } } },
      { agent_id: 'broken', agent_version: 1, status: 'error', narrative: null, created_at: 'T3', input: {}, facts: {} },
    ];
    const out = await getLatestFindings(1, ['technical-seo', 'sitemap', 'broken']);
    assert.deepEqual(out, [
      { agentId: 'technical-seo', agentVersion: 2, summary: 'n', findings: [{ id: 'f1' }], checkedPages: ['/a'], linkCrawlCheckedPages: ['/b'], start: '2026-09-01', end: '2026-09-28', createdAt: 'T' },
      { agentId: 'sitemap', agentVersion: 1, summary: null, findings: [], checkedPages: null, linkCrawlCheckedPages: null, start: null, end: null, createdAt: 'T2' },
    ], 'non-ok runs are still dropped');
  });
});
