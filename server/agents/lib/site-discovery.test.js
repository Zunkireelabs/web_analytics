import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobotsDisallowRules } from './site-discovery.js';

const ROBOTS_TXT = [
  'User-agent: *',
  'Disallow: /blog',
  'Allow: /blog/featured',
].join('\n');

describe('parseRobotsDisallowRules — matchingDisallow', () => {
  test('returns the winning Disallow pattern for a blocked path', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.matchingDisallow('/blog/some-post'), '/blog');
  });

  test('returns null for a path an Allow rule wins on (longest-match)', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.matchingDisallow('/blog/featured'), null);
  });

  test('returns null for a path with no matching rule at all', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.matchingDisallow('/about'), null);
  });

  test('stays consistent with isAllowed on the same paths', () => {
    const robots = parseRobotsDisallowRules(ROBOTS_TXT);
    assert.equal(robots.isAllowed('/blog/some-post'), false);
    assert.equal(robots.matchingDisallow('/blog/some-post') !== null, true);
    assert.equal(robots.isAllowed('/blog/featured'), true);
    assert.equal(robots.matchingDisallow('/blog/featured'), null);
  });
});
