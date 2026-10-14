import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  verificationMethodFor, VERIFICATION_METHOD, longestTextExcerpt, excerptNeedle,
} from './fix-verifications.js';
import { listGeneratorMeta } from '../generators/registry.js';

const ORIGIN = 'https://example.com';

function draft(overrides = {}) {
  return {
    action_type: 'expand-content',
    finding_id: 'f-1',
    source: 'auto-remediation',
    input: { page: `${ORIGIN}/page` },
    content: { sections: ['This is a reasonably long paragraph of generated prose that should be findable.'] },
    ...overrides,
  };
}

describe('verificationMethodFor — every generator has a decided method', () => {
  test('no registered generator is left without a verification decision', async () => {
    const metas = await listGeneratorMeta();
    const ids = (Array.isArray(metas) ? metas : Object.values(metas)).map((g) => g.id);
    assert.ok(ids.length >= 30, 'sanity: the generator registry should be populated');

    const undecided = [];
    for (const id of ids) {
      const plan = verificationMethodFor(draft({ action_type: id }), { siteOrigin: ORIGIN });
      if (!plan?.method) undecided.push(id);
      // An unverifiable decision is only acceptable WITH a stated reason.
      if (plan.method === VERIFICATION_METHOD.UNVERIFIABLE && !plan.reason) undecided.push(`${id} (no reason)`);
    }
    assert.deepEqual(undecided, [], 'every generator must resolve to a method, and unverifiable must carry a reason');
  });

  test('a report-only generator is explicitly unverifiable, never silently verified', () => {
    const plan = verificationMethodFor(draft({ action_type: 'geo-audit' }), { siteOrigin: ORIGIN });
    assert.equal(plan.method, VERIFICATION_METHOD.UNVERIFIABLE);
    assert.match(plan.reason, /audit report/i);
    assert.notEqual(plan.method, VERIFICATION_METHOD.PAGE_CONTENT);
  });

  test('the original nine keep their stronger detector re-run when they qualify for it', () => {
    const d = draft({ action_type: 'meta-title', source: 'opportunity', input: { page: `${ORIGIN}/p` } });
    assert.equal(verificationMethodFor(d, { siteOrigin: ORIGIN }).method, VERIFICATION_METHOD.TAG_RECHECK);
  });

  test('the same type from a source with no detector re-check still gets a real check, not nothing', () => {
    const d = draft({ action_type: 'canonical', source: 'technical-seo' });
    const plan = verificationMethodFor(d, { siteOrigin: ORIGIN });
    assert.equal(plan.method, VERIFICATION_METHOD.PAGE_CONTENT);
  });

  test('site-level assets verify against the site origin', () => {
    const plan = verificationMethodFor(draft({ action_type: 'llms-txt', input: {} }), { siteOrigin: ORIGIN });
    assert.equal(plan.method, VERIFICATION_METHOD.SITE_ASSET);
    assert.equal(plan.target, `${ORIGIN}/llms.txt`);
    assert.equal(plan.expected.structure, 'llms-txt');
  });

  test('a site with no configured domain says so instead of inventing a target', () => {
    const plan = verificationMethodFor(draft({ action_type: 'sitemap', input: {} }), { siteOrigin: null });
    assert.equal(plan.method, VERIFICATION_METHOD.UNVERIFIABLE);
    assert.match(plan.reason, /no site origin/i);
  });

  test('security-headers records the actual header names it shipped', () => {
    const d = draft({ action_type: 'security-headers', input: {}, content: { headers: { 'content-security-policy': "default-src 'self'" } } });
    const plan = verificationMethodFor(d, { siteOrigin: ORIGIN });
    assert.equal(plan.method, VERIFICATION_METHOD.RESPONSE_HEADER);
    assert.deepEqual(plan.expected.headers, ['content-security-policy']);
  });

  test('a change with no public URL falls back to the merged file, not to nothing', () => {
    const d = draft({
      action_type: 'blog-image', input: {},
      content: { imageAlt: 'A long descriptive alt text for the article hero image', appliedFiles: [{ filePath: 'src/blog/x.md' }] },
    });
    const plan = verificationMethodFor(d, { siteOrigin: ORIGIN });
    assert.equal(plan.method, VERIFICATION_METHOD.REPO_FILE);
    assert.deepEqual(plan.expected.files, ['src/blog/x.md']);
  });

  test('a change with neither a URL nor a file is unverifiable with a reason', () => {
    const d = draft({ action_type: 'direct-answer', input: {}, content: { note: 'tiny' } });
    const plan = verificationMethodFor(d, { siteOrigin: ORIGIN });
    assert.equal(plan.method, VERIFICATION_METHOD.UNVERIFIABLE);
    assert.ok(plan.reason.length > 0);
  });
});

describe('excerpt selection', () => {
  test('picks the longest prose string and ignores identifiers and file bodies', () => {
    const excerpt = longestTextExcerpt({
      slug: 'some-slug-that-is-quite-long-but-not-prose',
      body: 'The quick brown fox jumps over the lazy dog and keeps going for a while.',
      appliedFiles: [{ filePath: 'x', content: 'an even longer string living inside the applied file body that must be ignored entirely' }],
    });
    assert.match(excerpt, /quick brown fox/);
  });

  test('too-short content yields no needle, so nothing is matched on a coincidence', () => {
    assert.equal(excerptNeedle('too short'), null);
  });

  test('a long excerpt is matched on its middle, away from markdown edges', () => {
    const long = `${'a'.repeat(30)} ${'middle words here '.repeat(6)} ${'z'.repeat(30)}`;
    const needle = excerptNeedle(long);
    assert.ok(needle.length <= 70);
    assert.ok(!needle.startsWith('aaa'));
  });
});
