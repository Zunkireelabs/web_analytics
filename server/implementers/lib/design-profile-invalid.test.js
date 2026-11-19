import test from 'node:test';
import assert from 'node:assert/strict';
import { persistDesignProfile } from './design-drift.js';
import { DESIGN_PROFILE_VERSION } from '../../design-agent/lib/design-profile.js';

// mobilise.agency, 2026-11-19: the worker log said "unusable design profile — invalid-profile" and nothing else, so the failing rule could not be seen.
test('an unusable profile says which rules it failed, so the worker can log them', async () => {
  const profile = { version: DESIGN_PROFILE_VERSION, typography: { body: 'hub-sub', heading: { item: 'sec-title' } }, layout: {} };
  const r = await persistDesignProfile({ id: 1, url_file_map: {} }, profile, { saveConfig: async () => { throw new Error('must not save'); } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-profile');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /layout needs at least one of container\/prose/);
});

test('every failed rule is listed, not only the first', async () => {
  const r = await persistDesignProfile({ id: 1, url_file_map: {} }, { version: DESIGN_PROFILE_VERSION, typography: {} }, { saveConfig: async () => { throw new Error('must not save'); } });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});
