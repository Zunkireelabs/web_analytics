import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSiteCapabilities, hasRequiredCapabilities } from './site-capabilities.js';

test('a site with a public domain gets public-web, with or without GSC', () => {
  assert.ok(computeSiteCapabilities({ website_domain: 'example.com' }).has('public-web'));
  assert.ok(computeSiteCapabilities({ gsc_property: 'sc-domain:example.com' }).has('public-web'));
});

test('a product tenant with a public marketing site still gets public-web (property_type does not gate it)', () => {
  assert.ok(computeSiteCapabilities({ property_type: 'product', website_domain: 'zenly.example' }).has('public-web'));
});

test('a login-walled product with no public domain is not scheduled for live-page agents', () => {
  assert.equal(hasRequiredCapabilities({ property_type: 'product' }, ['public-web']), false);
  assert.equal(hasRequiredCapabilities({ property_type: 'product' }, []), true);
});
