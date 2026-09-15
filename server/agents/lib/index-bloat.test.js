import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectSpamUrlPatterns, detectForeignScriptQueries } from './index-bloat.js';

describe('detectSpamUrlPatterns', () => {
  test('groups foreign-platform-extension URLs by first path segment', () => {
    const pages = [
      { dim_value: 'https://example.com/shop/storeSearch/KeepCriteriaInput.aspx?&transition=top1', impressions: 3 },
      { dim_value: 'https://example.com/shop/other/page.aspx', impressions: 2 },
    ];
    const found = detectSpamUrlPatterns(pages);
    assert.equal(found.length, 1);
    assert.equal(found[0].pattern, '/shop/*');
    assert.equal(found[0].impressions, 5);
    assert.equal(found[0].samplePages.length, 2);
  });

  test('flags a lone short-name/long-numeric-value query param', () => {
    const pages = [{ dim_value: 'https://example.com/?h=8020347041280', impressions: 16 }];
    const found = detectSpamUrlPatterns(pages);
    assert.equal(found.length, 1);
    assert.equal(found[0].pattern, '/?h=*');
  });

  test('does not flag a real page with a normal query string', () => {
    const pages = [
      { dim_value: 'https://example.com/blog/post?utm_source=newsletter', impressions: 10 },
      { dim_value: 'https://example.com/pricing', impressions: 20 },
    ];
    assert.deepEqual(detectSpamUrlPatterns(pages), []);
  });

  test('does not flag a multi-param query string', () => {
    const pages = [{ dim_value: 'https://example.com/search?h=12345678&page=2', impressions: 1 }];
    assert.deepEqual(detectSpamUrlPatterns(pages), []);
  });

  test('skips an unparseable URL rather than throwing', () => {
    assert.deepEqual(detectSpamUrlPatterns([{ dim_value: 'not-a-url', impressions: 1 }]), []);
  });
});

describe('detectForeignScriptQueries', () => {
  test('flags an Arabic-script query on an English site', () => {
    const found = detectForeignScriptQueries([{ dim_value: 'عود اورفليم', impressions: 2 }], 'en');
    assert.equal(found.length, 1);
    assert.equal(found[0].script, 'ar');
  });

  test('does not flag a normal English query', () => {
    assert.deepEqual(detectForeignScriptQueries([{ dim_value: 'chalice court', impressions: 1 }], 'en'), []);
  });

  test('does not flag a query in the site\'s own declared language script', () => {
    assert.deepEqual(detectForeignScriptQueries([{ dim_value: 'شقق للايجار', impressions: 5 }], 'ar'), []);
  });
});
