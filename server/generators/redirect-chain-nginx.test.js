import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './redirect-chain-nginx.js';

describe('redirect-chain-nginx generator', () => {
  test('meta.id matches the risk-tiers/severity-tiers/coordinator wiring', () => {
    assert.equal(meta.id, 'redirect-chain-nginx');
  });

  test('requires page, currentHopTarget, and finalTarget', async () => {
    await assert.rejects(() => generate({ params: {} }));
    await assert.rejects(() => generate({ params: { page: 'https://example.com/old/' } }));
    await assert.rejects(() => generate({ params: { page: 'https://example.com/old/', currentHopTarget: '/mid/' } }));
  });

  test('returns a fixed, contentless-work draft — the real work happens at apply time', async () => {
    const draft = await generate({ params: { page: 'https://example.com/old/', currentHopTarget: '/mid/', finalTarget: '/new/' } });
    assert.deepEqual(draft.content, { page: 'https://example.com/old/', currentHopTarget: '/mid/', finalTarget: '/new/' });
    assert.match(draft.summary, /Collapse redirect chain/);
  });
});
