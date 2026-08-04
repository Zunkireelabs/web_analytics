import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// direct-answer.js imports store/read.js (getSearchPerformanceRange,
// getSiteById), which reaches server/db.js — same real, intentional
// DATABASE_URL-at-import-time check every other DB-importing test file in
// this repo works around the same way (see geo-audit.test.js). Only the
// input-validation path (which throws before any DB call) is exercised
// below, same convention as faq.test.js.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { generate, meta } = await import('./direct-answer.js');

describe('direct-answer generator', () => {
  test('requires query', async () => {
    await assert.rejects(() => generate({ siteId: 1, params: {} }));
  });

  test('meta.id matches the generatorId growth-queries wires into recommendedAction', () => {
    assert.equal(meta.id, 'direct-answer');
  });

  test('has a description', () => {
    assert.ok(meta.description.length > 0);
  });
});
