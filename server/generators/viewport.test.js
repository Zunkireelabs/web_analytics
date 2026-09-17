import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let analyzeImpl;
mock.module(resolve('../agents/lib/page-content.js'), {
  namedExports: { analyzePageUrl: async (url) => analyzeImpl(url) },
});

const { generate, meta, verifyCurrentState } = await import('./viewport.js');

describe('viewport generator', () => {
  test('always emits the same correct value — no params needed', async () => {
    const { content } = await generate({ params: {} });
    assert.equal(content.viewportContent, 'width=device-width, initial-scale=1');
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'viewport');
  });
});

describe('viewport verifyCurrentState (server/generators/lib/verification-layer.js contract)', () => {
  const site = { id: 1, website_domain: 'example.com' };

  test('no site context: still_valid without guessing', async () => {
    const result = await verifyCurrentState({ params: {} }, {});
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'no-site-context');
  });

  test('all three conditions correct: already_resolved', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { hasViewportMeta: true, viewportHasDeviceWidth: true, viewportBlocksZoom: false } });
    const result = await verifyCurrentState({ params: {} }, { site });
    assert.equal(result.decision, 'already_resolved');
  });

  test('present but zoom-blocking: still_valid — one fixed dimension is not the whole fix', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { hasViewportMeta: true, viewportHasDeviceWidth: true, viewportBlocksZoom: true } });
    const result = await verifyCurrentState({ params: {} }, { site });
    assert.equal(result.decision, 'still_valid');
    assert.equal(result.reason, 'viewport-still-needs-fix');
  });

  test('missing entirely: still_valid', async () => {
    analyzeImpl = async () => ({ ok: true, analysis: { hasViewportMeta: false, viewportHasDeviceWidth: false, viewportBlocksZoom: false } });
    const result = await verifyCurrentState({ params: {} }, { site });
    assert.equal(result.decision, 'still_valid');
  });
});
