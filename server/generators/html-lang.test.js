import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './html-lang.js';

// Only exercises the params.lang-provided path, which never calls
// getSiteById — no real DB needed. The site-config-lookup / 'en' fallback
// path is covered by injectHtmlLang's own tests plus manual/sandbox
// verification (see the plan's end-to-end verification steps), since it
// requires a real site row.
describe('html-lang generator', () => {
  test('uses an explicit params.lang override when given', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: 'fr' } });
    assert.equal(content.lang, 'fr');
  });

  test('accepts a region-qualified code', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: 'en-US' } });
    assert.equal(content.lang, 'en-US');
  });

  test('falls back to "en" for a malformed lang value rather than drafting garbage', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: 'not-a-lang-code!' } });
    assert.equal(content.lang, 'en');
  });

  test('falls back to "en" for an empty string', async () => {
    const { content } = await generate({ siteId: 1, params: { lang: '' } });
    assert.equal(content.lang, 'en');
  });

  test('summary names the resolved language', async () => {
    const { summary } = await generate({ siteId: 1, params: { lang: 'fr' } });
    assert.match(summary, /lang="fr"/);
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'html-lang');
  });
});
