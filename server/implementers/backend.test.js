import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLinkDataSourceEdit, stripGlobalJsonLink } from './backend.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Same real (trimmed) zunkireelabs-web content js-data-splice.test.js uses —
// see that file's fixture comment. ai-booking-engine's own loginUrl is the
// real dead-link shape this was built for (a stuck broken-link-fix draft
// whose href lived only in this scalar field, never as a hardcoded <a href>
// anywhere in the repo).
const productsDetails = readFileSync(
  join(HERE, 'adapters/lib/__fixtures__/productsDetails.json'), 'utf8',
);

describe('applyLinkDataSourceEdit — scalar field (no itemsField)', () => {
  const source = { dataFile: 'src/_data/productsDetails.json', urlField: 'loginUrl', format: 'json-array' };

  test('clears a matching scalar loginUrl, leaves the rest of the entry and file untouched', () => {
    const result = applyLinkDataSourceEdit(
      productsDetails, 'https://zunkireelabs.com/products/ai-booking-engine/',
      'https://zenly.zunkireelabs.com/login', source,
    );
    assert.equal(result.ok, true);
    const reparsed = JSON.parse(result.newContent);
    assert.equal(reparsed['ai-booking-engine'].loginUrl, '');
    // Untouched sibling fields and the other product entry.
    assert.equal(reparsed['ai-booking-engine'].id, 'ai-booking-engine');
    assert.equal(reparsed['dental-ai'].loginUrl, 'https://dental.zunkiree.com');
  });

  test('does not touch the file when the current value does not match the dead href', () => {
    const result = applyLinkDataSourceEdit(
      productsDetails, 'https://zunkireelabs.com/products/ai-booking-engine/',
      'https://not-the-real-login-url.example/', source,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('reports no-match, not a crash, when the field genuinely does not exist on the entry', () => {
    const result = applyLinkDataSourceEdit(
      productsDetails, 'https://zunkireelabs.com/products/ai-booking-engine/',
      'https://zenly.zunkireelabs.com/login', { ...source, urlField: 'signupUrl' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('unknown page id (no matching entry) is a clean no-match, not a crash', () => {
    const result = applyLinkDataSourceEdit(
      productsDetails, 'https://zunkireelabs.com/products/does-not-exist/',
      'https://zenly.zunkireelabs.com/login', source,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-match');
  });

  test('itemsField configs still use the original array-item removal path (regression)', () => {
    const arraySource = { dataFile: 'src/_data/productsDetails.json', itemsField: 'resources', urlField: 'url', format: 'json-array' };
    const result = applyLinkDataSourceEdit(
      productsDetails, 'https://zunkireelabs.com/products/ai-booking-engine/',
      '/resources/booking-best-practices/', arraySource,
    );
    assert.equal(result.ok, true);
    const reparsed = JSON.parse(result.newContent);
    assert.ok(!reparsed['ai-booking-engine'].resources.some((r) => r.url === '/resources/booking-best-practices/'));
  });
});

describe('stripGlobalJsonLink', () => {
  const siteJson = JSON.stringify({
    name: 'Zunkiree Labs',
    url: 'https://zunkireelabs.com',
    social: {
      twitter: 'https://twitter.com/zunkiree',
      linkedin: 'https://linkedin.com/company/zunkiree',
      github: 'https://github.com/zunkiree',
    },
  }, null, 2);

  test('removes the one nested field whose value matches the dead href', () => {
    const newContent = stripGlobalJsonLink(siteJson, 'https://github.com/zunkiree');
    assert.ok(newContent);
    const reparsed = JSON.parse(newContent);
    assert.equal(reparsed.social.github, undefined);
    assert.ok('twitter' in reparsed.social, 'unrelated sibling fields must be untouched');
    assert.equal(reparsed.social.twitter, 'https://twitter.com/zunkiree');
    assert.equal(reparsed.url, 'https://zunkireelabs.com');
  });

  test('returns null (no edit) when the href is not present anywhere', () => {
    assert.equal(stripGlobalJsonLink(siteJson, 'https://not-in-this-file.example/'), null);
  });

  test('refuses to guess when the same href value appears more than once', () => {
    const ambiguous = JSON.stringify({ a: 'https://dup.example/', nested: { b: 'https://dup.example/' } });
    assert.equal(stripGlobalJsonLink(ambiguous, 'https://dup.example/'), null);
  });

  test('returns null rather than throwing on invalid JSON', () => {
    assert.equal(stripGlobalJsonLink('{ not valid json', 'https://x.example/'), null);
  });
});
