import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAiVisibilityShipForAllSites } from './job.js';

// Injectable-deps surface only, same reason as job.keyword-gap-ship-cycle.test.js.
describe('runAiVisibilityShipForAllSites', () => {
  test('drafts every awaiting prompt for each site and counts them', async () => {
    const shipped = [];
    const t = await runAiVisibilityShipForAllSites({
      listAllSites: async () => [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
      listAwaiting: async (siteId) => (siteId === 1 ? [{ id: 10 }, { id: 11 }] : []),
      ship: async (siteId, p) => { shipped.push([siteId, p.id]); return { ok: true }; },
    });
    assert.deepEqual(shipped, [[1, 10], [1, 11]]);
    assert.deepEqual(t, { sites: 1, drafted: 2, failed: 0 });
  });

  test('a failed prompt is counted, and one failing site does not stop the next', async () => {
    const t = await runAiVisibilityShipForAllSites({
      listAllSites: async () => [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
      listAwaiting: async (siteId) => { if (siteId === 1) throw new Error('db down'); return [{ id: 20 }, { id: 21 }]; },
      ship: async (siteId, p) => ({ ok: p.id === 20 }),
    });
    assert.deepEqual(t, { sites: 1, drafted: 1, failed: 1 });
  });

  test('asks for at most perSiteLimit prompts per site', async () => {
    let asked;
    await runAiVisibilityShipForAllSites({
      listAllSites: async () => [{ id: 1, name: 'A' }],
      listAwaiting: async (siteId, limit) => { asked = limit; return []; },
      ship: async () => ({ ok: true }),
      perSiteLimit: 3,
    });
    assert.equal(asked, 3);
  });
});
