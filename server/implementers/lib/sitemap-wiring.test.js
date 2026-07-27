import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { meta as backendMeta } from '../backend.js';
import { MERGE_MANDATORY_TYPES } from '../../store/drafts.js';

// Regression guard for the sitemap action type's wiring into the existing
// draft -> branch -> PR -> human-merge flow (server/implementers/types.js's
// apply() contract) — no GitHub/DB calls, just confirms the registration
// points a new action type must land in are actually set.

describe('sitemap action_type wiring', () => {
  test('backend implementer declares it handles "sitemap"', () => {
    assert.ok(backendMeta.handles.includes('sitemap'));
  });

  test('"sitemap" requires a real PR merge before it can reach implemented — no direct/auto-merge bypass', () => {
    assert.ok(MERGE_MANDATORY_TYPES.includes('sitemap'));
  });
});
