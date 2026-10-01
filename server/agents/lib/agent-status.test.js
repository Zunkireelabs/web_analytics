import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

let metas;
let summaryRows;
let geoScore;
let summaryCalls;

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../registry.js'), {
  namedExports: { listAgentMeta: async () => metas },
});
mock.module(resolve('../../store/agent-runs.js'), {
  namedExports: {
    getLatestAgentRunSummaries: async (siteId, ids) => { summaryCalls.push({ siteId, ids }); return summaryRows; },
  },
});
mock.module(resolve('../../store/drafts.js'), {
  namedExports: { getLatestGeoAuditScore: async () => geoScore },
});
const { getAgentStatusList } = await import('./agent-status.js');

describe('getAgentStatusList (reads summaries, not whole runs)', () => {
  test('maps the SQL-extracted finding count and scores onto the same fields the old facts-based code produced', async () => {
    metas = [{ id: 'authority' }, { id: 'ai-visibility' }, { id: 'geo-signals' }, { id: 'sitemap' }, { id: 'never-ran' }];
    geoScore = 64;
    summaryCalls = [];
    summaryRows = [
      { agent_id: 'authority', status: 'ok', created_at: 't1', finding_count: 4, authority_score: 55, site_score_overall: null },
      { agent_id: 'ai-visibility', status: 'ok', created_at: 't2', finding_count: 0, authority_score: null, site_score_overall: 71 },
      { agent_id: 'geo-signals', status: 'ok', created_at: 't3', finding_count: 2, authority_score: null, site_score_overall: null },
      { agent_id: 'sitemap', status: 'error', created_at: 't4', finding_count: null, authority_score: null, site_score_overall: null },
    ];
    const list = await getAgentStatusList(9);
    const by = Object.fromEntries(list.map((a) => [a.id, a]));

    assert.deepEqual(summaryCalls, [{ siteId: 9, ids: ['authority', 'ai-visibility', 'geo-signals', 'sitemap', 'never-ran'] }]);
    assert.equal(by.authority.lastRunScore, 55);
    assert.equal(by.authority.lastRunFindings, 4);
    assert.equal(by['ai-visibility'].lastRunScore, 71);
    assert.equal(by['ai-visibility'].lastRunFindings, 0, 'zero findings stays 0, not null');
    assert.equal(by['geo-signals'].lastRunScore, 64, 'geo-signals still takes the geo-audit report score');
    assert.equal(by.sitemap.lastRunStatus, 'error');
    assert.equal(by.sitemap.lastRunFindings, null, 'a run with no findings array reports null');
    assert.equal(by.sitemap.lastRunScore, null);
    assert.deepEqual(
      [by['never-ran'].lastRunStatus, by['never-ran'].lastRunAt, by['never-ran'].lastRunFindings, by['never-ran'].lastRunScore],
      [null, null, null, null],
    );
  });

  test('no geo-audit report means a null geo-signals score, not a crash', async () => {
    metas = [{ id: 'geo-signals' }];
    geoScore = null;
    summaryRows = [];
    summaryCalls = [];
    const [a] = await getAgentStatusList(1);
    assert.equal(a.lastRunScore, null);
  });
});
