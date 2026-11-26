import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rerenderAbandonedBlogDrafts } from './rerender-blog-drafts.js';

const mkDb = (rows) => {
  const writes = []; const reads = [];
  const query = async (sql, p) => {
    if (/^\s*SELECT/i.test(sql)) { reads.push(p); return { rows: rows.filter((r) => r.site_id === p[0]) }; }
    writes.push({ sql, p }); const r = rows.find((x) => x.id === p[1] && x.site_id === p[0] && x.status === 'abandoned');
    if (r) r.status = 'draft'; return { rowCount: r ? 1 : 0 };
  };
  return { query, writes, reads };
};
const row = (id, site_id = 8864) => ({ id, site_id, action_type: 'blog-outline', status: 'abandoned', content: { title: `t${id}` }, input: {}, abandoned_reason: 'Auto-ship failed: Rendered into a real "inline-article" page on this site it measures differently: body-size 19 → 17' });
const site = { id: 8864, repo_owner: 'o', repo_name: 'r' };
const deps = (failIds = []) => ({
  getSite: async () => site,
  resolveTargetAndBody: async (s, d) => ({ ok: true, filePath: `src/blog/${d.content.title}.md`, body: `body ${d.content.title}`, contentFormat: 'markdown' }),
  validateRendering: async (s, f) => (failIds.some((i) => f.path.includes(`t${i}.`)) ? { ok: false, error: 'body-size 20 → 18' } : { ok: true }),
  log: { error() {} },
});

describe('re-rendering abandoned articles', () => {
  test('dry run: reports what would be restored and writes nothing', async () => {
    const db = mkDb([row(1), row(2)]);
    const r = await rerenderAbandonedBlogDrafts(8864, { ...deps(), query: db.query });
    assert.equal(r.candidates, 2); assert.equal(r.restorable, 2); assert.equal(r.restored, 0); assert.equal(db.writes.length, 0);
    assert.ok(r.items.every((i) => i.result === 'would-restore'));
  });
  test('apply: restores only the articles that pass the unchanged gate; a failing one stays abandoned with its new reason', async () => {
    const rows = [row(1), row(2), row(3)]; const db = mkDb(rows);
    const r = await rerenderAbandonedBlogDrafts(8864, { ...deps([2]), query: db.query, apply: true });
    assert.equal(r.restored, 2); assert.equal(r.stillFailing, 1);
    assert.deepEqual(r.items.map((i) => i.result), ['restored', 'still-fails-the-gate', 'restored']);
    assert.equal(rows[1].status, 'abandoned'); assert.match(r.items[1].detail, /body-size/);
  });
  test('the stored (stale) rendered body is never reused: every article is rendered again', async () => {
    const seen = []; const d = deps(); const db = mkDb([{ ...row(1), rendered_body: 'OLD LANDING BODY' }]);
    await rerenderAbandonedBlogDrafts(8864, { ...d, query: db.query, resolveTargetAndBody: async (s, dr) => { seen.push(dr); return d.resolveTargetAndBody(s, dr); } });
    assert.equal(seen.length, 1); assert.equal(seen[0].rendered_body, undefined);
  });
  test('tenant scoped: only the given project\'s articles are read or written', async () => {
    const db = mkDb([row(1, 8864), row(9, 8862)]);
    const r = await rerenderAbandonedBlogDrafts(8864, { ...deps(), query: db.query, apply: true });
    assert.equal(r.candidates, 1); assert.ok(db.writes.every((w) => w.p[0] === 8864)); assert.ok(db.reads.every((p) => p[0] === 8864));
  });
  test('a backup of the rows is taken before the first write', async () => {
    const order = []; const db = mkDb([row(1)]); const q = db.query;
    await rerenderAbandonedBlogDrafts(8864, { ...deps(), query: async (s, p) => { if (!/^\s*SELECT/i.test(s)) order.push('write'); return q(s, p); }, apply: true, backup: async () => { order.push('backup'); } });
    assert.deepEqual(order, ['backup', 'write']);
  });
  test('a render error on one article does not stop the rest, and is reported', async () => {
    const d = deps(); const db = mkDb([row(1), row(2)]);
    const r = await rerenderAbandonedBlogDrafts(8864, { ...d, query: db.query, apply: true, resolveTargetAndBody: async (s, dr) => { if (dr.content.title === 't1') throw new Error('boom'); return d.resolveTargetAndBody(s, dr); } });
    assert.deepEqual(r.items.map((i) => i.result), ['error', 'restored']);
  });
  test('a project with no repository is skipped, not an error', async () => {
    const r = await rerenderAbandonedBlogDrafts(1, { ...deps(), getSite: async () => ({ id: 1 }), query: mkDb([]).query });
    assert.equal(r.skipped, 'no-repository');
  });
});

describe('the runner only acts when told to, and only on safe, named repairs', async () => {
  const { actOnFindings } = await import('./index.js');
  const finding = { kind: 'blog-render-mismatch', proposal: { action: 'rerender-abandoned-drafts', safe: true } };
  test('default (SELF_REPAIR_ACT unset): nothing is executed, the finding stays a proposal', async () => {
    let ran = 0; const done = await actOnFindings(1, [finding], { env: {}, actions: { 'rerender-abandoned-drafts': async () => { ran++; return {}; } } });
    assert.equal(ran, 0); assert.deepEqual(done, []);
  });
  test('SELF_REPAIR_ACT=on: the named safe repair runs for that project only', async () => {
    const seen = []; const done = await actOnFindings(8864, [finding, { kind: 'x', proposal: { action: 'deploy-sibling-derivation', safe: true } }, { kind: 'y', proposal: { action: 'rerender-abandoned-drafts', safe: false } }],
      { env: { SELF_REPAIR_ACT: 'on' }, actions: { 'rerender-abandoned-drafts': async (id) => { seen.push(id); return { restored: 3, stillFailing: 0 }; } } });
    assert.deepEqual(seen, [8864]); assert.equal(done.length, 1); assert.equal(done[0].result.restored, 3);
  });
  test('a failing repair is reported, never thrown', async () => {
    const done = await actOnFindings(1, [finding], { env: { SELF_REPAIR_ACT: 'on' }, actions: { 'rerender-abandoned-drafts': async () => { throw new Error('boom'); } } });
    assert.equal(done[0].error, 'boom');
  });
});

describe('re-deriving a project\'s design profile is queued for that project only', async () => {
  const { actOnFindings } = await import('./index.js');
  test('the Admizz repair queues exactly one rescan, for its own site, and writes no config', async () => {
    const calls = [];
    const done = await actOnFindings(8862, [{ kind: 'blog-waiting-on-design-decision', proposal: { action: 'rederive-design-profile', safe: true } }],
      { env: { SELF_REPAIR_ACT: 'on' }, getSite: async (id) => ({ id, name: 'Admizz' }), rescan: async (site, o) => { calls.push({ site: site.id, force: o.force }); return true; } });
    assert.deepEqual(calls, [{ site: 8862, force: true }]); assert.equal(done[0].result.queued, true);
  });
  test('off by default: nothing is queued', async () => {
    let n = 0; await actOnFindings(8862, [{ kind: 'k', proposal: { action: 'rederive-design-profile', safe: true } }], { env: {}, getSite: async () => ({}), rescan: async () => { n++; } });
    assert.equal(n, 0);
  });
});
