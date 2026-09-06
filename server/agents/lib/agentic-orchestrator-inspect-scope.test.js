import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { siteInspectHostnames, checkInspectableUrl } from './agentic-orchestrator.js';

// The inspect_* tools fetch a URL supplied by the MODEL, server-side. That was
// tolerable while the Copilot was platform_admin-only; it is not once any
// authenticated client can drive the conversation, because a user can steer
// the model into requesting URLs only this server can reach. These tests pin
// the allowlist behaviour that closes that hole.

const SITE = { website_domain: 'lifelinknepal.com', gsc_property: 'sc-domain:lifelinknepal.com' };

describe('siteInspectHostnames', () => {
  test('derives the host from website_domain and gsc_property alike', () => {
    const hosts = siteInspectHostnames(SITE);
    assert.deepEqual([...hosts], ['lifelinknepal.com']);
  });

  test('strips a leading www so both forms resolve to one entry', () => {
    assert.deepEqual([...siteInspectHostnames({ website_domain: 'https://www.example.com/' })], ['example.com']);
  });

  test('a site with no domain configured yields an empty allowlist, not a wildcard', () => {
    assert.equal(siteInspectHostnames({}).size, 0);
    assert.equal(siteInspectHostnames(null).size, 0);
  });
});

describe('checkInspectableUrl — allows the tenant\'s own site', () => {
  const hosts = siteInspectHostnames(SITE);

  test('exact host', () => {
    assert.equal(checkInspectableUrl('https://lifelinknepal.com/about', hosts).ok, true);
  });

  test('www and http variants', () => {
    assert.equal(checkInspectableUrl('https://www.lifelinknepal.com/', hosts).ok, true);
    assert.equal(checkInspectableUrl('http://lifelinknepal.com/', hosts).ok, true);
  });

  test('a genuine subdomain', () => {
    assert.equal(checkInspectableUrl('https://blog.lifelinknepal.com/post', hosts).ok, true);
  });
});

describe('checkInspectableUrl — blocks everything else', () => {
  const hosts = siteInspectHostnames(SITE);

  test('another tenant\'s site', () => {
    const r = checkInspectableUrl('https://zunkireelabs.com/', hosts);
    assert.equal(r.ok, false);
    assert.match(r.error, /own domain/);
  });

  test('a suffix-collision domain an endsWith check would have allowed', () => {
    // The exact bug a naive `host.endsWith('lifelinknepal.com')` introduces.
    assert.equal(checkInspectableUrl('https://evil-lifelinknepal.com/', hosts).ok, false);
    assert.equal(checkInspectableUrl('https://notlifelinknepal.com/', hosts).ok, false);
  });

  test('loopback and link-local addresses the server can reach but the user cannot', () => {
    assert.equal(checkInspectableUrl('http://localhost:3002/api/sites', hosts).ok, false);
    assert.equal(checkInspectableUrl('http://127.0.0.1/', hosts).ok, false);
    assert.equal(checkInspectableUrl('http://169.254.169.254/latest/meta-data/', hosts).ok, false);
    assert.equal(checkInspectableUrl('http://10.0.0.5/internal', hosts).ok, false);
    assert.equal(checkInspectableUrl('http://[::1]/', hosts).ok, false);
  });

  test('non-http schemes', () => {
    assert.equal(checkInspectableUrl('file:///etc/passwd', hosts).ok, false);
    assert.equal(checkInspectableUrl('data:text/html,<h1>x</h1>', hosts).ok, false);
    assert.equal(checkInspectableUrl('gopher://example.com/', hosts).ok, false);
  });

  test('garbage and relative URLs', () => {
    assert.equal(checkInspectableUrl('not a url', hosts).ok, false);
    assert.equal(checkInspectableUrl('/relative/path', hosts).ok, false);
    assert.equal(checkInspectableUrl('', hosts).ok, false);
  });

  test('an empty allowlist blocks everything rather than allowing everything', () => {
    const r = checkInspectableUrl('https://lifelinknepal.com/', new Set());
    assert.equal(r.ok, false, 'a site with no verified domain must not become a wildcard fetcher');
    assert.match(r.error, /no verified domain/);
  });
});
