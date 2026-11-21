import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromotionBranch } from './promotion-branch.js';

// An in-memory repo: refs name a snapshot of { path: content }.
function repo({ main, snapshots, prFiles, parents }) {
  const calls = { branches: [], commits: [] };
  return {
    calls,
    deps: {
      readSha: async (_s, b) => { if (b !== 'main') throw new Error('unexpected base'); return 'MAIN'; },
      makeBranch: async (_s, name, sha) => { calls.branches.push([name, sha]); },
      commit: async (_s, name, files, message) => { calls.commits.push([name, files, message]); },
      readFile: async (_s, path, ref) => {
        const snap = ref === 'MAIN' ? main : snapshots[ref];
        if (!snap) throw new Error(`no snapshot ${ref}`);
        return Object.prototype.hasOwnProperty.call(snap, path) && snap[path] !== null ? { content: snap[path] } : null;
      },
      listFiles: async (_s, n) => prFiles[n],
      parentOf: async (_s, sha) => parents[sha],
    },
  };
}
const SITE = { repo_owner: 'o', repo_name: 'r' };
const pr = (number, mergeSha, mergedAt) => ({ number, mergeSha, mergedAt, title: `PR ${number}`, url: `https://gh/pr/${number}` });

test('replays a modified and an added file onto main; stage-only extras are NOT carried', async () => {
  const r = repo({
    main: { 'a.md': 'old', 'keep.md': 'k' },
    snapshots: { P1: { 'a.md': 'old' }, M1: { 'a.md': 'new', 'b.md': 'added', 'stage-only.md': 'x' } },
    prFiles: { 1: [{ path: 'a.md', status: 'modified' }, { path: 'b.md', status: 'added' }] },
    parents: { M1: 'P1' },
  });
  const out = await buildPromotionBranch(SITE, { main: 'main', prs: [pr(1, 'M1', '2026-01-01')], branchName: 'promote/x' }, r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(out.applied.map((a) => a.number), [1]);
  assert.deepEqual(r.calls.branches, [['promote/x', 'MAIN']], 'cut from the LATEST main tip');
  const files = Object.fromEntries(r.calls.commits[0][1].map((f) => [f.path, f.content]));
  assert.deepEqual(files, { 'a.md': 'new', 'b.md': 'added' });
  assert.ok(!('stage-only.md' in files), 'a file that is on stage but in no approved PR is never promoted');
});

test('a removed file is deleted; a renamed file is removed and re-added', async () => {
  const r = repo({
    main: { 'gone.md': 'g', 'old-name.md': 'body' },
    snapshots: { P1: { 'gone.md': 'g', 'old-name.md': 'body' }, M1: { 'new-name.md': 'body' } },
    prFiles: { 1: [{ path: 'gone.md', status: 'removed' }, { path: 'new-name.md', status: 'renamed', previousPath: 'old-name.md' }] },
    parents: { M1: 'P1' },
  });
  await buildPromotionBranch(SITE, { main: 'main', prs: [pr(1, 'M1', '2026-01-01')], branchName: 'promote/x' }, r.deps);
  const byPath = Object.fromEntries(r.calls.commits[0][1].map((f) => [f.path, f]));
  assert.equal(byPath['gone.md'].delete, true);
  assert.equal(byPath['old-name.md'].delete, true);
  assert.equal(byPath['new-name.md'].content, 'body');
});

test('main has moved on that file since: the WHOLE PR is skipped with the reason, and nothing from it is applied', async () => {
  const r = repo({
    main: { 'a.md': 'main edited it', 'b.md': 'b-old' },
    snapshots: { P1: { 'a.md': 'old', 'b.md': 'b-old' }, M1: { 'a.md': 'new', 'b.md': 'b-new' } },
    prFiles: { 1: [{ path: 'b.md', status: 'modified' }, { path: 'a.md', status: 'modified' }] },
    parents: { M1: 'P1' },
  });
  const out = await buildPromotionBranch(SITE, { main: 'main', prs: [pr(1, 'M1', '2026-01-01')], branchName: 'promote/x' }, r.deps);
  assert.deepEqual(out.skipped, [{ number: 1, reason: 'main-changed', detail: 'a.md' }]);
  assert.equal(out.noChange, true);
  assert.equal(r.calls.branches.length, 0, 'no branch, no commit when there is nothing safe to promote');
});

test('one conflicting PR does not stop the others', async () => {
  const r = repo({
    main: { 'a.md': 'diverged', 'c.md': 'c-old' },
    snapshots: { P1: { 'a.md': 'old' }, M1: { 'a.md': 'new' }, P2: { 'c.md': 'c-old' }, M2: { 'c.md': 'c-new' } },
    prFiles: { 1: [{ path: 'a.md', status: 'modified' }], 2: [{ path: 'c.md', status: 'modified' }] },
    parents: { M1: 'P1', M2: 'P2' },
  });
  const out = await buildPromotionBranch(SITE, { main: 'main', prs: [pr(1, 'M1', '2026-01-01'), pr(2, 'M2', '2026-01-02')], branchName: 'promote/x' }, r.deps);
  assert.deepEqual(out.applied.map((a) => a.number), [2]);
  assert.deepEqual(out.skipped.map((s) => s.number), [1]);
  assert.deepEqual(r.calls.commits[0][1], [{ path: 'c.md', content: 'c-new' }]);
});

test('PRs touching the same file are replayed in merge order, each on top of the last', async () => {
  const r = repo({
    main: { 'a.md': 'v0' },
    snapshots: { P1: { 'a.md': 'v0' }, M1: { 'a.md': 'v1' }, P2: { 'a.md': 'v1' }, M2: { 'a.md': 'v2' } },
    prFiles: { 1: [{ path: 'a.md', status: 'modified' }], 2: [{ path: 'a.md', status: 'modified' }] },
    parents: { M1: 'P1', M2: 'P2' },
  });
  // handed over out of order on purpose
  const out = await buildPromotionBranch(SITE, { main: 'main', prs: [pr(2, 'M2', '2026-01-02'), pr(1, 'M1', '2026-01-01')], branchName: 'promote/x' }, r.deps);
  assert.deepEqual(out.applied.map((a) => a.number), [1, 2]);
  assert.deepEqual(r.calls.commits[0][1], [{ path: 'a.md', content: 'v2' }]);
});

test('a file main already has in its final form is not a conflict and not a change', async () => {
  const r = repo({
    main: { 'a.md': 'new' },
    snapshots: { P1: { 'a.md': 'old' }, M1: { 'a.md': 'new' } },
    prFiles: { 1: [{ path: 'a.md', status: 'modified' }] },
    parents: { M1: 'P1' },
  });
  const out = await buildPromotionBranch(SITE, { main: 'main', prs: [pr(1, 'M1', '2026-01-01')], branchName: 'promote/x' }, r.deps);
  assert.equal(out.noChange, true);
  assert.equal(out.skipped.length, 0);
});

test('a PR with a binary file is skipped, never corrupted through a text round-trip', async () => {
  const r = repo({ main: {}, snapshots: { P1: {}, M1: {} }, prFiles: { 1: [{ path: 'img/logo.png', status: 'added' }] }, parents: { M1: 'P1' } });
  const out = await buildPromotionBranch(SITE, { main: 'main', prs: [pr(1, 'M1', '2026-01-01')], branchName: 'promote/x' }, r.deps);
  assert.deepEqual(out.skipped, [{ number: 1, reason: 'binary-file', detail: 'img/logo.png' }]);
});

test('a PR GitHub gives no merge commit for is skipped honestly', async () => {
  const r = repo({ main: {}, snapshots: {}, prFiles: {}, parents: {} });
  const out = await buildPromotionBranch(SITE, { main: 'main', prs: [{ number: 9, mergeSha: null, mergedAt: 'x' }], branchName: 'promote/x' }, r.deps);
  assert.equal(out.skipped[0].reason, 'no-merge-commit');
});

test('bad input is refused, not guessed at', async () => {
  assert.equal((await buildPromotionBranch(SITE, { main: 'main', prs: 'nope', branchName: 'b' }, {})).reason, 'bad-input');
  assert.equal((await buildPromotionBranch(SITE, { prs: [], branchName: 'b' }, {})).reason, 'bad-input');
});
