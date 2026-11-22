import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readSharedDomain, validateSharedDomain, applyToUrlFileMap } from './shared-domain-settings.js';

const site = { website_domain: 'zennly.io', repo_owner: 'o', repo_name: 'r', scope_exclude_paths: ['/business'], url_file_map: { pages: { '/': 'a' } } };

describe('shared domain settings', () => {
  test('reads defaults for a site that has none', () => {
    assert.deepEqual(readSharedDomain({}), { scopeIncludePaths: [], scopeExcludePaths: [], writeAllow: [], writeDeny: [], crossSiteLinks: [], markerSetupEnabled: false });
  });
  test('reads what is stored', () => {
    const r = readSharedDomain({ ...site, url_file_map: { writeScope: { allow: ['src/'], deny: ['x'] }, crossSiteLinks: [{ url: 'https://zennly.io/business' }], markerSetup: { enabled: true } } });
    assert.deepEqual(r.scopeExcludePaths, ['/business']);
    assert.deepEqual(r.writeAllow, ['src/']);
    assert.deepEqual(r.crossSiteLinks, ['https://zennly.io/business']);
    assert.equal(r.markerSetupEnabled, true);
  });
  test('normalises paths and drops duplicates', () => {
    const v = validateSharedDomain({ scopeIncludePaths: ['business/', '/business', ' /blog '] }, { ...site, scope_exclude_paths: [] });
    assert.equal(v.ok, true);
    assert.deepEqual(v.changes.scopeIncludePaths, ['/business', '/blog']);
  });
  test('refuses the whole site, queries, hosts and traversal as a path', () => {
    for (const bad of ['/', '/a?b=1', 'https://x.com/a', '/a/../b', '/a b']) {
      assert.equal(validateSharedDomain({ scopeIncludePaths: [bad] }, site).ok, false, bad);
    }
  });
  test('refuses a path that is both owned and left out', () => {
    const v = validateSharedDomain({ scopeIncludePaths: ['/business'] }, site);
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /both owned and left out/);
  });
  test('refuses unsafe repo paths', () => {
    for (const bad of ['../x', '/etc/passwd/../x', 'src/*', 'a\\b', 'https://x']) {
      assert.equal(validateSharedDomain({ writeAllow: [bad] }, site).ok, false, bad);
    }
    const ok = validateSharedDomain({ writeAllow: ['./src/marketplace/', '/src/shared'] }, site);
    assert.deepEqual(ok.changes.writeAllow, ['src/marketplace', 'src/shared']);
  });
  test('refuses a path both allowed and denied', () => {
    assert.equal(validateSharedDomain({ writeAllow: ['src/a'], writeDeny: ['src/a'] }, site).ok, false);
  });
  test('cross-site links must be on the site\'s own domain', () => {
    assert.equal(validateSharedDomain({ crossSiteLinks: ['https://other.com/x'] }, site).ok, false);
    assert.equal(validateSharedDomain({ crossSiteLinks: ['not a url'] }, site).ok, false);
    const ok = validateSharedDomain({ crossSiteLinks: ['https://www.zennly.io/business'] }, site);
    assert.equal(ok.ok, true);
  });
  test('marker setup needs a connected repo to be switched on, never to be switched off', () => {
    const noRepo = { ...site, repo_owner: null, repo_name: null };
    assert.equal(validateSharedDomain({ markerSetupEnabled: true }, noRepo).ok, false);
    assert.equal(validateSharedDomain({ markerSetupEnabled: false }, noRepo).ok, true);
    assert.equal(validateSharedDomain({ markerSetupEnabled: 'yes' }, site).ok, false);
  });
  test('only the keys sent are changed', () => {
    assert.deepEqual(validateSharedDomain({ markerSetupEnabled: true }, site).changes, { markerSetupEnabled: true });
  });
  test('applying keeps other url_file_map keys and removes cleared ones', () => {
    const base = { pages: { '/': 'a' }, writeScope: { allow: ['a'], deny: [] }, crossSiteLinks: [{ url: 'https://zennly.io/b' }], markerSetup: { enabled: true, other: 1 } };
    const n = applyToUrlFileMap(base, { writeAllow: [], crossSiteLinks: [], markerSetupEnabled: false });
    assert.deepEqual(n.pages, base.pages);
    assert.equal('writeScope' in n, false);
    assert.equal('crossSiteLinks' in n, false);
    assert.deepEqual(n.markerSetup, { enabled: false, other: 1 });
    assert.deepEqual(base.writeScope, { allow: ['a'], deny: [] }, 'input is not mutated');
  });
  test('setting only one write list keeps the other', () => {
    const n = applyToUrlFileMap({ writeScope: { allow: ['a'], deny: ['b'] } }, { writeDeny: ['c'] });
    assert.deepEqual(n.writeScope, { allow: ['a'], deny: ['c'] });
  });
});
