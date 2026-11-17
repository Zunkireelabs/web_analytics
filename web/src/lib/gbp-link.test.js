import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProfileLink } from './gbp-link.js';

test('profile links from Share profile → Copy link, and Maps addresses, are accepted', () => {
  for (const u of ['https://share.google/1maAsqJRhlqN8sKpl', 'https://maps.app.goo.gl/AbC123', 'g.page/example-removals',
    'https://www.google.com/maps/place/Example+Removals/@52.2,-0.9,17z', 'https://maps.google.co.uk/?cid=123', 'https://business.google.com/n/123/profile']) {
    assert.equal(classifyProfileLink(u), 'ok', u);
  }
});

test('the list of all profiles is not a profile link', () => {
  for (const u of ['https://business.google.com/locations', 'business.google.com/', 'https://business.google.com/dashboard']) {
    assert.equal(classifyProfileLink(u), 'list', u);
  }
});

test('their own website, or a Google page that is not Maps, is called out as not a profile link', () => {
  assert.equal(classifyProfileLink('https://chayceproperties.com/'), 'website');
  assert.equal(classifyProfileLink('https://www.google.com/search?q=example'), 'website');
});

test('empty and junk', () => {
  assert.equal(classifyProfileLink('   '), 'empty');
  assert.equal(classifyProfileLink('my business'), 'invalid');
});
