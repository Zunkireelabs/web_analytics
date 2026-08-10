import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetAndBody, FRONTEND_ACTION_TYPES, COMPLIANCE_ACTION_TYPES } from './frontend.js';

describe('resolveTargetAndBody — generation-time-prepared fast path', () => {
  test('a draft with rendered_body/target_file_path already set is returned verbatim, no recomputation', async () => {
    const draft = {
      action_type: 'privacy-policy',
      rendered_body: '---\ntitle: "Privacy Policy"\n---\n\n# Privacy Policy\n',
      target_file_path: 'src/pages/privacy-policy.njk',
      content: { headline: 'Privacy Policy' },
    };
    // No site.repo_owner/repo_name/url_file_map at all — if this fell
    // through to the real computation path it would throw/return not-ok.
    const result = await resolveTargetAndBody({}, draft);
    assert.equal(result.ok, true);
    assert.equal(result.filePath, 'src/pages/privacy-policy.njk');
    assert.equal(result.body, draft.rendered_body);
    assert.equal(result.contentFormat, 'markdown');
  });

  test('a draft with only one of the two prepared fields set falls through to real computation, not a broken fast path', async () => {
    const draft = { action_type: 'landing-page', rendered_body: 'some body', target_file_path: null, content: {} };
    const result = await resolveTargetAndBody({ url_file_map: {} }, draft);
    // Falls through to the real landing-page branch, which fails honestly
    // (no newContentTargets configured) rather than silently using a
    // half-prepared cache.
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-file-mapping');
  });

  test('a draft with neither prepared field set computes fresh, unaffected by the fast path', async () => {
    const draft = { action_type: 'blog-outline', content: { title: 'Hello' } };
    const result = await resolveTargetAndBody({ url_file_map: {} }, draft);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-file-mapping');
  });
});

describe('FRONTEND_ACTION_TYPES / COMPLIANCE_ACTION_TYPES', () => {
  test('FRONTEND_ACTION_TYPES matches meta.handles exactly', async () => {
    const { meta } = await import('./frontend.js');
    assert.deepEqual([...FRONTEND_ACTION_TYPES].sort(), [...meta.handles].sort());
  });

  test('every compliance action type is also a frontend action type', () => {
    for (const t of COMPLIANCE_ACTION_TYPES) assert.ok(FRONTEND_ACTION_TYPES.has(t), `${t} should be in FRONTEND_ACTION_TYPES`);
  });
});
