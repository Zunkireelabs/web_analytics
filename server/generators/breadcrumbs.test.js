import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generate, meta } from './breadcrumbs.js';

// Only exercises the input-validation path, which throws before ever
// calling getSiteById — no real DB needed. The domain-confirmation/
// success path is covered by manual/sandbox verification, same convention
// as canonical.test.js.
describe('breadcrumbs generator', () => {
  test('requires page', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });

  test('rejects a malformed page URL before touching the database', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: { page: 'not a url' } }));
  });

  test('refuses the site root before touching the database', async () => {
    await assert.rejects(
      () => generate({ siteId: 1, params: { page: 'https://example.com/' } }),
      /site root/i,
    );
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'breadcrumbs');
  });
});

// The existing-BreadcrumbList duplicate-schema guard (mirrors schema.js's
// own existing-schema-type refusal) needs both a real DB row (getSiteById)
// and a stubbed fetch — this repo's generator tests deliberately stop
// short of DB mocking (no such convention/harness exists here, unlike the
// fetch-stub convention schema.test.js/qa-content.test.js etc. use), so
// this path is covered by manual/sandbox verification instead, same as the
// domain-confirmation/success path noted above.
