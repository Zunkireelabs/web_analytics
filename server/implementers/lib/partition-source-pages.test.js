import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// A pure function, deliberately zero-mocking — see its own comment in
// backend.js for why (the file it lives in can't be safely imported under
// node:test's module-mocking loader, same known limitation job.js has).
const { partitionSourcePagesByOwnDomain } = await import(resolve('../backend.js'));

const site = {
  website_domain: 'zunkireelabs.com',
  additional_own_domains: ['zenly.zunkireelabs.com', 'edgex.zunkireelabs.com'],
};

describe('partitionSourcePagesByOwnDomain — regression, real incident (draft 3011, Zunkiree Labs)', () => {
  test('a staging/dev subdomain not in ownDomains is partitioned as foreign', () => {
    const result = partitionSourcePagesByOwnDomain(site, ['https://dev-web.zunkireelabs.com/contact/']);
    assert.deepEqual(result.ownPages, []);
    assert.deepEqual(result.foreignPages, ['https://dev-web.zunkireelabs.com/contact/']);
  });

  test('the primary domain is own', () => {
    const result = partitionSourcePagesByOwnDomain(site, ['https://zunkireelabs.com/contact/']);
    assert.deepEqual(result.ownPages, ['https://zunkireelabs.com/contact/']);
    assert.deepEqual(result.foreignPages, []);
  });

  test('a registered additional_own_domains host (zenly/edgex) is own, not foreign', () => {
    const result = partitionSourcePagesByOwnDomain(site, ['https://zenly.zunkireelabs.com/login/', 'https://edgex.zunkireelabs.com/dashboard/']);
    assert.deepEqual(result.ownPages, ['https://zenly.zunkireelabs.com/login/', 'https://edgex.zunkireelabs.com/dashboard/']);
    assert.deepEqual(result.foreignPages, []);
  });

  test('a mixed list is partitioned correctly, preserving order within each bucket', () => {
    const pages = [
      'https://dev-web.zunkireelabs.com/a/',
      'https://zunkireelabs.com/b/',
      'https://some-other-blog.example/c/',
      'https://zenly.zunkireelabs.com/d/',
    ];
    const result = partitionSourcePagesByOwnDomain(site, pages);
    assert.deepEqual(result.ownPages, ['https://zunkireelabs.com/b/', 'https://zenly.zunkireelabs.com/d/']);
    assert.deepEqual(result.foreignPages, ['https://dev-web.zunkireelabs.com/a/', 'https://some-other-blog.example/c/']);
  });

  test('a site with no website_domain configured passes everything through as own (unfiltered)', () => {
    const result = partitionSourcePagesByOwnDomain({}, ['https://dev-web.zunkireelabs.com/contact/']);
    assert.deepEqual(result.ownPages, ['https://dev-web.zunkireelabs.com/contact/']);
    assert.deepEqual(result.foreignPages, []);
  });

  test('an empty sourcePages list returns empty buckets, not an error', () => {
    const result = partitionSourcePagesByOwnDomain(site, []);
    assert.deepEqual(result.ownPages, []);
    assert.deepEqual(result.foreignPages, []);
  });
});
