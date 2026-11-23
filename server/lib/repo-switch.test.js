import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isRepoSwitch, repoKey, resetMapForNewRepo, applyRepoSwitchReset } from './repo-switch.js';

const site = (o, n) => ({ repo_owner: o, repo_name: n });
const oldMap = () => ({
  _rev: 50, approvers: ['yukta-commits'],
  pages: { '/faq': { file: 'src/faq.njk' } }, patterns: [{ match: '^/blog/', file: 'src/blog/$1.njk' }], defaults: { placements: {} },
  newContentTargets: { 'blog-outline': { dir: 'docs' } }, notApplicable: [{ match: '/x', actions: ['faq'], reason: 'r' }], renderCapabilities: { generator: 'eleventy' },
  areas: [{ name: 'a' }], mounts: [{ prefix: '/b' }],
  siteRoot: { layoutTemplate: 'src/_includes/base.njk', designProfile: { pages: [1, 2, 3] }, componentTemplates: { faq: { row: 'r' } }, nginxConfig: 'nginx/static.conf' },
});

describe('isRepoSwitch: only a move to a DIFFERENT repository counts', () => {
  test('different owner or name is a move; the case of the name does not matter', () => {
    assert.equal(isRepoSwitch(site('Zunkireelabs', 'web-zenly'), site('Zunkireelabs', 'zennly-marketplace')), true);
    assert.equal(isRepoSwitch(site('a', 'x'), site('b', 'x')), true);
    assert.equal(isRepoSwitch(site('Zunkireelabs', 'Web-Zenly'), site('zunkireelabs', 'web-zenly')), false);
  });
  test('a first connection, a disconnect, or the same repo (another branch) is not a move', () => {
    assert.equal(isRepoSwitch(site(null, null), site('a', 'b')), false);
    assert.equal(isRepoSwitch({}, site('a', 'b')), false);
    assert.equal(isRepoSwitch(site('a', 'b'), site('a', 'b')), false);
    assert.equal(isRepoSwitch(site('a', 'b'), site(null, null)), false);
    assert.equal(isRepoSwitch(null, null), false);
    assert.equal(repoKey(site('A', 'B')), 'a/b');
  });
});

describe('resetMapForNewRepo: everything repo-specific is cleared, the old map is kept whole', () => {
  test('only the approvers and the revision counter stay on the live map', () => {
    const next = resetMapForNewRepo(oldMap(), { from: 'Zunkireelabs/web-zenly', to: 'Zunkireelabs/zennly-marketplace', at: '2026-11-24T00:00:00.000Z' });
    assert.deepEqual(Object.keys(next).sort(), ['_previousRepo', '_rev', 'approvers']);
    assert.equal(next._rev, 50); assert.deepEqual(next.approvers, ['yukta-commits']);
    for (const k of ['pages', 'patterns', 'defaults', 'newContentTargets', 'notApplicable', 'renderCapabilities', 'areas', 'mounts', 'siteRoot']) assert.equal(k in next, false, k);
  });
  test('the old map is kept exactly, with where it came from and where it went', () => {
    const before = oldMap();
    const next = resetMapForNewRepo(before, { from: 'o/old', to: 'o/new', at: 'T' });
    assert.deepEqual(next._previousRepo, { repo: 'o/old', switchedTo: 'o/new', switchedAt: 'T', map: before });
    assert.equal(next._previousRepo.map.siteRoot.designProfile.pages.length, 3);
  });
  test('only one generation is kept: an earlier _previousRepo is dropped, not nested', () => {
    const twice = resetMapForNewRepo(resetMapForNewRepo(oldMap(), { from: 'o/a', to: 'o/b' }), { from: 'o/b', to: 'o/c' });
    assert.equal(twice._previousRepo.repo, 'o/b'); assert.equal('_previousRepo' in twice._previousRepo.map, false);
  });
  test('the input map is not mutated, and an empty or missing map is fine', () => {
    const before = oldMap(); const snap = JSON.stringify(before);
    resetMapForNewRepo(before, { from: 'a/b', to: 'c/d' }); assert.equal(JSON.stringify(before), snap);
    assert.deepEqual(Object.keys(resetMapForNewRepo(null, { from: 'a/b', to: 'c/d' })), ['_previousRepo']);
  });
});

describe('applyRepoSwitchReset: a row-locked write, safe to repeat', () => {
  const fakePatch = (initial) => { const st = { map: initial, writes: 0 }; st.patch = async (_id, mutator) => { const next = await mutator(JSON.parse(JSON.stringify(st.map))); if (next == null) return { changed: false }; st.map = next; st.writes++; return { changed: true }; }; return st; };
  test('resets once and reports it', async () => {
    const st = fakePatch(oldMap());
    assert.deepEqual(await applyRepoSwitchReset(8872, { from: 'o/web-zenly', to: 'o/zennly-marketplace' }, { patch: st.patch }), { reset: true });
    assert.equal(st.writes, 1); assert.equal(st.map._previousRepo.repo, 'o/web-zenly'); assert.equal('pages' in st.map, false);
  });
  test('the same move repeated writes nothing and keeps the first snapshot', async () => {
    const st = fakePatch(oldMap());
    await applyRepoSwitchReset(8872, { from: 'o/a', to: 'o/b' }, { patch: st.patch });
    const firstSwitchedAt = st.map._previousRepo.switchedAt;
    assert.deepEqual(await applyRepoSwitchReset(8872, { from: 'o/a', to: 'o/b' }, { patch: st.patch }), { reset: false });
    assert.equal(st.writes, 1); assert.equal(st.map._previousRepo.switchedAt, firstSwitchedAt);
  });
  test('a different, later move is a new reset', async () => {
    const st = fakePatch(oldMap());
    await applyRepoSwitchReset(1, { from: 'o/a', to: 'o/b' }, { patch: st.patch });
    assert.deepEqual(await applyRepoSwitchReset(1, { from: 'o/b', to: 'o/c' }, { patch: st.patch }), { reset: true });
    assert.equal(st.map._previousRepo.repo, 'o/b');
  });
});
