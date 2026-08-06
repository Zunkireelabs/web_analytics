import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './analytics-install.js';

describe('analytics-install generator', () => {
  test('meta.id matches the generatorId trust-compliance.js wires into recommendedAction', () => {
    assert.equal(meta.id, 'analytics-install');
  });

  test('rejects an unknown provider', async () => {
    await assert.rejects(() => generate({ params: { provider: 'tiktok-pixel' } }));
  });

  test('ships a placeholder-blocked draft when no real tracking ID is given', async () => {
    const { content } = await generate({ params: { provider: 'ga4', page: 'https://example.com/' } });
    assert.deepEqual(content.placeholderFields, ['trackingId']);
    assert.match(content.script, /NEEDS INPUT/);
  });

  test('drafts a real GA4 script when a valid measurement ID is given', async () => {
    const { content, summary } = await generate({ params: { provider: 'ga4', trackingId: 'G-ABC1234XYZ' } });
    assert.deepEqual(content.placeholderFields, []);
    assert.match(content.script, /G-ABC1234XYZ/);
    assert.doesNotMatch(summary, /needs real tracking ID/);
  });

  test('drafts a real Facebook Pixel script when a valid numeric ID is given', async () => {
    const { content } = await generate({ params: { provider: 'facebook-pixel', trackingId: '123456789012345' } });
    assert.deepEqual(content.placeholderFields, []);
    assert.match(content.script, /123456789012345/);
    assert.match(content.script, /fbevents\.js/);
  });

  test('falls back to a placeholder when the given ID does not match the provider\'s real ID shape', () => {
    return generate({ params: { provider: 'ga4', trackingId: 'not-a-real-id' } }).then(({ content }) => {
      assert.deepEqual(content.placeholderFields, ['trackingId']);
    });
  });
});
