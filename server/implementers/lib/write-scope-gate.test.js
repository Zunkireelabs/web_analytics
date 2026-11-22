import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathWritable, validateWriteScope, writeScopeOf } from './write-scope-gate.js';

const site = (writeScope) => ({ url_file_map: { writeScope } });
const business = site({ allow: ['src/business/', './src/data/business.json'], deny: ['src/business/shared'] });
const marketplace = site({ deny: ['src/business'] });

describe('repo write scope', () => {
  test('a site without a write scope may write anywhere, as today', () => {
    for (const s of [{}, null, site({}), site({ allow: [], deny: [] })]) assert.equal(pathWritable(s, 'src/anything.njk'), true);
  });
  test('allow limits the site to its prefixes, on a segment boundary', () => {
    assert.equal(pathWritable(business, 'src/business/blog/a.md'), true);
    assert.equal(pathWritable(business, 'src/data/business.json'), true);
    assert.equal(pathWritable(business, 'src/business-old/a.md'), false);
    assert.equal(pathWritable(business, 'src/_includes/layout.njk'), false);
    assert.equal(pathWritable(business, 'sitemap.xml'), false);
  });
  test('deny always wins, even inside an allow', () => {
    assert.equal(pathWritable(business, 'src/business/shared/nav.njk'), false);
    assert.equal(pathWritable(business, 'src/business/shared'), false);
  });
  test('a deny-only site (the marketplace) may write everything but the other site', () => {
    assert.equal(pathWritable(marketplace, 'src/index.njk'), true);
    assert.equal(pathWritable(marketplace, 'src/business/pricing.njk'), false);
  });
  test('the batch result names the offending files and writes nothing', () => {
    assert.deepEqual(validateWriteScope(business, [{ path: 'src/business/a.md' }]), { ok: true });
    const r = validateWriteScope(business, [{ path: 'src/business/a.md' }, { path: 'robots.txt' }, { path: 'llms.txt' }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'outside-write-scope');
    assert.match(r.error, /robots\.txt, llms\.txt/);
  });
  test('garbage config is tolerated', () => {
    assert.deepEqual(writeScopeOf(site({ allow: 'x', deny: [null, '', '/a/'] })), { allow: [], deny: ['a'] });
    assert.equal(pathWritable(business, ''), false);
  });
});
