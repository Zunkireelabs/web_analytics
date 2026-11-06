import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReviewStore, reviewStateOf, addProvisional, approveProposal, rejectProposal, rollbackLast, listPending,
  lookupMemo, rememberResult, appendEvidence, emptyState, currentRevision, ReviewConflict, MAX_TRANSIENT_ATTEMPTS,
} from './design-review-store.js';

const O = 'https://x.test';
const entry = (path, cls) => ({ url: O + path, pageType: 'other', sections: [{ role: 'content', classes: cls }] });
const siteRoot = () => ({
  untouchedOtherConfig: { keep: true },
  designProfile: {
    typography: { body: 'b' },
    pages: [entry('/blog/a', 'post'), entry('/services/x', 'svc')],
    layoutGroups: { revision: 3, groups: [
      { id: 'g1', size: 3, sample: '/blog/a', members: ['/blog/a', '/blog/b', '/blog/c'] },
      { id: 'g2', size: 1, sample: '/services/x', members: ['/services/x'] },
    ] },
  },
});
const T = new Date('2026-11-07T10:00:00Z');
const withProposal = (root, proposal) => {
  const { state, id } = addProvisional(reviewStateOf(root), proposal, { baseRevision: currentRevision(root), now: T });
  return { root: { ...root, designReview: state }, id };
};

// An in-memory "database row" with a real lock: concurrent callers are serialized, like SELECT … FOR UPDATE.
function fakeDb(initialRoot) {
  let ufm = { siteRoot: initialRoot, pages: { '/': 'x' } };
  let chain = Promise.resolve();
  const writes = [];
  const withSiteLock = (siteId, fn) => {
    const run = chain.then(async () => {
      const snapshot = JSON.parse(JSON.stringify(ufm));
      await new Promise((r) => setTimeout(r, 5)); // widen the window a race would need
      const out = await fn(snapshot);
      if (out?.urlFileMap) { ufm = out.urlFileMap; writes.push(out.urlFileMap); }
      return out?.value;
    });
    chain = run.catch(() => {});
    return run;
  };
  return { withSiteLock, get: () => ufm, writes };
}

describe('provisional proposals', () => {
  test('a repeat of the same proposal for the same page/layout is de-duplicated, not stacked', () => {
    let state = emptyState();
    const p = { kind: 'new-group', pageUrl: O + '/blog/c', capture: { fingerprint: { hash: 'h1' } }, entry: entry('/blog/c', 'n') };
    const a = addProvisional(state, p, { baseRevision: 3, now: T }); state = a.state;
    const b = addProvisional(state, p, { baseRevision: 3, now: T }); state = b.state;
    assert.equal(b.id, a.id); assert.equal(b.deduplicated, true);
    assert.equal(listPending(state).length, 1); assert.equal(listPending(state)[0].seen, 2);
  });
  test('a newer proposal for the same page supersedes the older one', () => {
    let state = addProvisional(emptyState(), { kind: 'new-group', pageUrl: O + '/blog/c', capture: { fingerprint: { hash: 'h1' } } }, { baseRevision: 3, now: T }).state;
    state = addProvisional(state, { kind: 'new-group', pageUrl: O + '/blog/c', capture: { fingerprint: { hash: 'h2' } } }, { baseRevision: 3, now: T }).state;
    assert.equal(listPending(state).length, 1);
    assert.equal(Object.values(state.provisional).filter((p) => p.status === 'superseded').length, 1);
  });
});

describe('approval — the only way the shared group map changes', () => {
  test('approving a new-group moves only that page; every other page keeps its group and baseline', () => {
    const { root, id } = withProposal(siteRoot(), { kind: 'new-group', pageUrl: O + '/blog/c', entry: entry('/blog/c', 'new'), capture: { fingerprint: { hash: 'h' } } });
    const after = approveProposal(root, id, { by: 'Reviewer', expectedRevision: 3, now: T });
    const g1 = after.designProfile.layoutGroups.groups.find((g) => g.id === 'g1');
    assert.deepEqual(g1.members, ['/blog/a', '/blog/b']);
    assert.equal(g1.sample, '/blog/a', 'the shared group\'s baseline is untouched');
    assert.equal(after.designProfile.layoutGroups.groups.length, 3);
    assert.equal(after.designProfile.layoutGroups.revision, 4);
    assert.deepEqual(after.untouchedOtherConfig, { keep: true });
    assert.equal(after.designReview.history.at(-1).by, 'Reviewer');
    assert.equal(after.designReview.provisional[id].status, 'approved');
  });

  test('approval requires a named person and the revision they reviewed', () => {
    const { root, id } = withProposal(siteRoot(), { kind: 'join', groupId: 'g2', pageUrl: O + '/blog/c' });
    assert.throws(() => approveProposal(root, id, { expectedRevision: 3 }), (e) => e.code === 'approver-required');
    assert.throws(() => approveProposal(root, id, { by: 'R', expectedRevision: 2 }), (e) => e instanceof ReviewConflict && e.code === 'revision-conflict');
  });

  test('a group\'s sample page cannot be moved away by a join/new-group (it would orphan the group\'s baseline)', () => {
    const { root, id } = withProposal(siteRoot(), { kind: 'join', groupId: 'g2', pageUrl: O + '/blog/a' });
    assert.throws(() => approveProposal(root, id, { by: 'R', expectedRevision: 3 }), (e) => e.code === 'is-group-sample');
  });

  test('replace-sample changes the baseline only when a person approves it, and is fully reversible', () => {
    const original = siteRoot();
    const { root, id } = withProposal(original, { kind: 'replace-sample', groupId: 'g1', pageUrl: O + '/blog/b', entry: entry('/blog/b', 'post-v2') });
    const after = approveProposal(root, id, { by: 'R', expectedRevision: 3, now: T });
    assert.equal(after.designProfile.layoutGroups.groups.find((g) => g.id === 'g1').sample, '/blog/b');
    const rolled = rollbackLast(after, { by: 'R', expectedRevision: 4, now: T });
    assert.deepEqual(rolled.designProfile.layoutGroups.groups, original.designProfile.layoutGroups.groups, 'groups restored exactly');
    assert.deepEqual(rolled.designProfile.pages.map((p) => p.url).sort(), original.designProfile.pages.map((p) => p.url).sort(), 'pages restored');
    assert.equal(rolled.designProfile.layoutGroups.revision, 5, 'rollback is itself a new, recorded revision');
    assert.equal(rolled.designReview.provisional[id].status, 'rolled-back');
  });

  test('rollback refuses when the map was changed outside the recorded history', () => {
    const { root, id } = withProposal(siteRoot(), { kind: 'join', groupId: 'g2', pageUrl: O + '/blog/c' });
    const after = approveProposal(root, id, { by: 'R', expectedRevision: 3, now: T });
    after.designProfile.layoutGroups.revision = 9; // someone else wrote
    assert.throws(() => rollbackLast(after, { by: 'R', expectedRevision: 9 }), (e) => e.code === 'history-mismatch');
  });

  test('reject records who and keeps the map unchanged', () => {
    const { root, id } = withProposal(siteRoot(), { kind: 'join', groupId: 'g2', pageUrl: O + '/blog/c' });
    const after = rejectProposal(root, id, { by: 'R', note: 'not the same layout', now: T });
    assert.deepEqual(after.designProfile, root.designProfile);
    assert.equal(after.designReview.provisional[id].decidedBy, 'R');
  });
});

describe('persistence: row-locked, revision-aware (H3)', () => {
  test('two people approving different proposals against the same revision: exactly one wins, the other gets a conflict — nothing is lost', async () => {
    let root = siteRoot();
    const a = withProposal(root, { kind: 'join', groupId: 'g2', pageUrl: O + '/blog/b' }); root = a.root;
    const b = withProposal(root, { kind: 'join', groupId: 'g2', pageUrl: O + '/blog/c' }); root = b.root;
    const db = fakeDb(root);
    const store = createReviewStore({ withSiteLock: db.withSiteLock, now: () => T });
    const results = await Promise.allSettled([
      store.approve(1, a.id, { by: 'A', expectedRevision: 3 }),
      store.approve(1, b.id, { by: 'B', expectedRevision: 3 }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'revision-conflict');
    assert.equal(db.get().siteRoot.designProfile.layoutGroups.revision, 4);
    assert.deepEqual(db.get().pages, { '/': 'x' }, 'the rest of url_file_map is preserved from the fresh row');
  });

  test('concurrent validations recording evidence never lose each other\'s writes and never touch the group map', async () => {
    const db = fakeDb(siteRoot());
    const store = createReviewStore({ withSiteLock: db.withSiteLock, now: () => T });
    const groupsBefore = JSON.stringify(db.get().siteRoot.designProfile.layoutGroups);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.recordValidation(1, {
      pagePath: `/blog/p${i}`,
      evidence: { kind: 'validation', status: 'provisional', n: i },
      result: { outcome: 'provisional', fingerprintHash: `h${i}` },
      proposal: { kind: 'new-group', pageUrl: `${O}/blog/p${i}`, capture: { fingerprint: { hash: `h${i}` } } },
    })));
    const state = reviewStateOf(db.get().siteRoot);
    assert.equal(state.evidence.length, 10);
    assert.equal(Object.keys(state.pageResults).length, 10);
    assert.equal(listPending(state).length, 10);
    assert.equal(JSON.stringify(db.get().siteRoot.designProfile.layoutGroups), groupsBefore, 'validation never changes the shared map');
  });
});

describe('remembered results (M3) and bounded retries', () => {
  test('an unchanged page reuses its answer; a changed page or an expired memo does not', () => {
    const s = rememberResult(emptyState(), '/blog/b', { outcome: 'matched', fingerprintHash: 'h', groupId: 'g1' }, T);
    assert.equal(lookupMemo(s, '/blog/b', 'h', T).usable, true);
    assert.equal(lookupMemo(s, '/blog/b', 'other', T), null);
    assert.equal(lookupMemo(s, '/blog/b', 'h', new Date(T.getTime() + 25 * 3600_000)), null);
  });
  test('a transient block backs off with growing delays and parks the page after the attempt cap', () => {
    let s = emptyState();
    let t = T;
    for (let i = 1; i <= MAX_TRANSIENT_ATTEMPTS; i++) {
      s = rememberResult(s, '/p', { outcome: 'blocked', reason: 'page-unreachable', transient: true }, t);
      const memo = lookupMemo(s, '/p', null, t);
      assert.equal(memo.usable, false);
      assert.equal(memo.waitingFor, i < MAX_TRANSIENT_ATTEMPTS ? 'backoff' : 'review');
      t = new Date(Date.parse(s.pageResults['/p'].retryAfter) + 1);
      if (i < MAX_TRANSIENT_ATTEMPTS) assert.equal(lookupMemo(s, '/p', null, t), null, 'after the backoff it may be retried');
    }
  });
  test('a permanent block (not transient) parks immediately for review', () => {
    const s = rememberResult(emptyState(), '/p', { outcome: 'blocked', reason: 'page-structure-unreadable', transient: false }, T);
    assert.equal(lookupMemo(s, '/p', null, T).waitingFor, 'review');
  });
  test('evidence is bounded', () => {
    let s = emptyState();
    for (let i = 0; i < 400; i++) s = appendEvidence(s, { n: i }, T);
    assert.equal(s.evidence.length, 300); assert.equal(s.evidence[0].n, 100);
  });
});
