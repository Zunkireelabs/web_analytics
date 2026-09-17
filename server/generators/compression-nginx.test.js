import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './compression-nginx.js';

describe('compression-nginx generator', () => {
  test('emits gzip and brotli by default', async () => {
    const { content } = await generate({ params: {} });
    assert.equal(content.includeBrotli, true);
    assert.match(content.nginxBlock, /gzip on;/);
    assert.match(content.nginxBlock, /brotli on;/);
  });

  test('omits brotli when includeBrotli is explicitly false', async () => {
    const { content } = await generate({ params: { includeBrotli: false } });
    assert.equal(content.includeBrotli, false);
    assert.match(content.nginxBlock, /gzip on;/);
    assert.doesNotMatch(content.nginxBlock, /brotli/);
  });

  test('defaults to including brotli when params is absent entirely', async () => {
    const { content } = await generate({});
    assert.equal(content.includeBrotli, true);
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'compression-nginx');
  });
});
