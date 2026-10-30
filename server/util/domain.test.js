import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain } from './domain.js';

test('addresses are reduced to one bare hostname', () => {
  for (const [input, want] of [
    ['example.com', 'example.com'], ['https://WWW.Example.com/', 'example.com'], ['http://blog.acme.co.uk/a/b?x=1#y', 'blog.acme.co.uk'],
    ['sc-domain:acme.com', 'acme.com'], ['acme.com:8080/path', 'acme.com'], ['  Acme.com.  ', 'acme.com'],
  ]) assert.deepEqual(normalizeDomain(input), { ok: true, domain: want }, input);
});
test('nothing given is fine and means no domain', () => {
  assert.deepEqual(normalizeDomain(''), { ok: true, domain: null });
  assert.deepEqual(normalizeDomain(null), { ok: true, domain: null });
});
test('things that are not a website address are refused', () => {
  for (const bad of ['asdf', 'a b.com', 'exa_mple.com', '-bad.com', 'bad-.com', 'x.c', 'http://', '.com', 'localhost']) {
    assert.equal(normalizeDomain(bad).ok, false, bad);
  }
});
