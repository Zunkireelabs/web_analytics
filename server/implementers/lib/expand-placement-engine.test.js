import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInsertion } from './insertion-engine.js';

// Separate from insertion-engine.test.js, which needs a live database for the
// learned-strategy registry. Plain Markdown never reaches that registry, so
// the placement option is exercised here without one.

describe('resolveInsertion — expand-content placement option', () => {
  const page = '---\ntitle: x\n---\n\n## Eligibility\n\nText.\n\n## Frequently asked questions\n\nQ\n';
  const map = { expandedContent: 'EXPAND' };
  const site = { id: 1 };

  test('without the option the marker lands where the engine always put it (the end)', async () => {
    const r = await resolveInsertion(site, page, 'p.md', map);
    assert.ok(r.content.indexOf('SEOAI:EXPAND:START') > r.content.indexOf('Frequently asked'));
  });

  test('with the option a NEW marker goes above the trailing FAQ', async () => {
    const r = await resolveInsertion(site, page, 'p.md', map, { placement: { field: 'expandedContent', beforeRoles: ['faq', 'cta'] } });
    assert.ok(r.content.indexOf('SEOAI:EXPAND:START') < r.content.indexOf('Frequently asked'));
    assert.ok(r.content.indexOf('SEOAI:EXPAND:START') > r.content.indexOf('Eligibility'));
  });

  test('an existing marker is never moved', async () => {
    const withMarker = `${page}\n<!-- SEOAI:EXPAND:START --><!-- SEOAI:EXPAND:END -->\n`;
    const r = await resolveInsertion(site, withMarker, 'p.md', map, { placement: { field: 'expandedContent', beforeRoles: ['faq', 'cta'] } });
    assert.equal(r.content, withMarker);
  });
});
