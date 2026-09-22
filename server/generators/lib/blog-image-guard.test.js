import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findBlogImageIssues } from './blog-image-guard.js';

const ORIG_ENV = { ...process.env };

describe('findBlogImageIssues', () => {
  beforeEach(() => {
    process.env = { ...ORIG_ENV, PEXELS_API_KEY: 'k', BLOG_IMAGES_ENABLED: 'true' };
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; });

  test('no-op for a generator other than blog-outline', () => {
    const { issues } = findBlogImageIssues('expand-content', {});
    assert.deepEqual(issues, []);
  });

  test('no-op when images are not configured for this deployment', () => {
    delete process.env.PEXELS_API_KEY;
    const { issues } = findBlogImageIssues('blog-outline', {});
    assert.deepEqual(issues, []);
  });

  test('no-op when the draft has a featuredImage', () => {
    const { issues } = findBlogImageIssues('blog-outline', { featuredImage: { url: 'https://images.pexels.com/photos/1/x.jpeg' } });
    assert.deepEqual(issues, []);
  });

  test('flags a missing featuredImage, blocking by default (enforce defaults true)', () => {
    const { issues } = findBlogImageIssues('blog-outline', { title: 'A post' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'missing-featured-image');
    assert.equal(issues[0].blocking, true);
  });

  test('enforce:false (manual Generate) still reports the issue but non-blocking', () => {
    const { issues } = findBlogImageIssues('blog-outline', { title: 'A post' }, { enforce: false });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].blocking, false);
  });
});
