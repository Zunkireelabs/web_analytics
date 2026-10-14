import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../registry.js'), {
  namedExports: { listAgentMeta: async () => [{ id: 'authority', version: 3 }, { id: 'sitemap', version: 1 }] },
});
mock.module(resolve('../../store/agent-runs.js'), {
  namedExports: {
    getLatestAgentRuns: async () => [],
    getLatestFindings: async () => [],
    getLatestAgentRunSummaries: async () => [
      { agent_id: 'authority', agent_version: 2, created_at: 'old' },      // older than current v3 -> stale
      { agent_id: 'sitemap', agent_version: 1, created_at: 'ok' },         // current
      { agent_id: 'retired-agent', agent_version: 1, created_at: 'keep' }, // unknown agent -> fail open
    ],
  },
});
const { getLatestAgentRunSummaries } = await import('./fresh-runs.js');

describe('fresh-runs getLatestAgentRunSummaries', () => {
  test('applies the same stale-version rule as getLatestAgentRuns, so switching callers to the slim read keeps "stale row == never ran"', async () => {
    const runs = await getLatestAgentRunSummaries(1, ['authority', 'sitemap', 'retired-agent']);
    assert.deepEqual(runs.map((r) => r.agent_id), ['sitemap', 'retired-agent']);
  });
});
