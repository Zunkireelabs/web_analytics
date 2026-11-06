import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ga4PagesHandler } from './ga4-pages-handler.js';

// The response shape the handler passes through is getTopPages' real return shape (store/ga4-pages.js, covered against a
// real database in store/ga4-pages.db.test.js); here only the HTTP edge is under test.
const run = async (query, getTopPages, siteId = 7) => {
  let status = 200; let body; let err;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await ga4PagesHandler({ getTopPages })(({ query, siteId }), res, (e) => { err = e; });
  return { status, body, err };
};
const ok = async (siteId, opts) => ({ pages: [], current: {}, previous: {}, dataQuality: {}, _got: { siteId, opts } });

describe('GET /ga4-pages', () => {
  test('reads the site from the session, never from the query string', async () => {
    const out = await run({ start: '2026-10-01', end: '2026-10-28', siteId: '99', site: '99' }, ok, 7);
    assert.equal(out.body._got.siteId, 7);
  });

  test('passes the range through, with no compare window unless one was asked for', async () => {
    const out = await run({ start: '2026-10-01', end: '2026-10-28' }, ok);
    assert.deepEqual(out.body._got.opts, { start: '2026-10-01', end: '2026-10-28' });
  });

  test('passes an explicit compare window through (the Overview compare modes)', async () => {
    const out = await run({ start: '2026-10-01', end: '2026-10-28', compareStart: '2025-10-01', compareEnd: '2025-10-28' }, ok);
    assert.deepEqual(out.body._got.opts, { start: '2026-10-01', end: '2026-10-28', compareStart: '2025-10-01', compareEnd: '2025-10-28' });
  });

  for (const [name, q] of [
    ['missing dates', {}],
    ['a malformed date', { start: '10/01/2026', end: '2026-10-28' }],
    ['an impossible date', { start: '2026-13-45', end: '2026-10-28' }],
    ['start after end', { start: '2026-10-28', end: '2026-10-01' }],
    ['a half-specified compare window', { start: '2026-10-01', end: '2026-10-28', compareStart: '2026-09-01' }],
    ['a reversed compare window', { start: '2026-10-01', end: '2026-10-28', compareStart: '2026-09-28', compareEnd: '2026-09-01' }],
  ]) {
    test(`rejects ${name} with 400 and never reaches the store`, async () => {
      let called = false;
      const out = await run(q, async () => { called = true; return {}; });
      assert.equal(out.status, 400);
      assert.equal(called, false);
    });
  }

  test('a store failure goes to the error handler, not a half-written response', async () => {
    const out = await run({ start: '2026-10-01', end: '2026-10-28' }, async () => { throw new Error('boom'); });
    assert.equal(out.err.message, 'boom');
    assert.equal(out.body, undefined);
  });
});
