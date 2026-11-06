import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { repairStaleFileMapping, staleMappingBlockedReason } = await import(new URL('./stale-mapping-repair.js', import.meta.url).href);

// The zunkireelabs-web case: src/pages/index.njk was deleted on 2 Oct 2026, the homepage is now src/pages/homepage-v2.njk.
const mkSite = (over = {}) => ({
  id: 1, repo_owner: 'zunkireelabs', repo_name: 'zunkireelabs-web', repo_default_branch: 'main', website_domain: 'zunkireelabs.com',
  url_file_map: { pages: { '/': { file: 'src/pages/index.njk', note: 'keep me' } } }, ...over,
});
const PAGE = 'https://zunkireelabs.com/';
const STALE = 'src/pages/index.njk';
const tpl = (permalink) => ({ content: `---\npermalink: ${permalink}\n---\n<h1>x</h1>` });

function harness({ tree, files, site = mkSite(), live = site, fail = {} } = {}) {
  const calls = { writes: [], audits: [], fetched: [] };
  return {
    calls,
    deps: {
      fetchTree: async () => { if (fail.tree) throw new Error(fail.tree); return tree ?? { files: Object.keys(files), truncated: false }; },
      fetchFile: async (_s, path) => {
        calls.fetched.push(path);
        if (fail.file === path) throw new Error('GitHub 502');
        return files[path] || null;
      },
      loadSite: async () => { if (fail.load) throw new Error('db down'); return live; },
      persist: async (args) => { calls.writes.push(args); return { ...live, url_file_map: args.urlFileMap }; },
      record: async (siteId, rec) => { if (fail.audit) return false; calls.audits.push({ siteId, ...rec }); return true; },
      log: { log: () => {}, warn: () => {} },
    },
    site,
  };
}

describe('repairStaleFileMapping', () => {
  test('unique permalink match: detects the stale mapping, finds homepage-v2.njk, repairs it with evidence and audit', async () => {
    const h = harness({ files: {
      'src/pages/homepage-v2.njk': tpl('/'), 'src/pages/about.njk': tpl('/about/'), 'src/_includes/layout.njk': { content: '<html>' },
    } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'repaired');
    assert.equal(r.newFile, 'src/pages/homepage-v2.njk');
    assert.equal(h.calls.writes.length, 1);
    const cfg = h.calls.writes[0].urlFileMap;
    assert.equal(cfg.pages['/'].file, 'src/pages/homepage-v2.njk');
    assert.equal(cfg.pages['/'].note, 'keep me', 'other fields on the entry are preserved');
    const a = h.calls.audits.at(-1);
    assert.equal(a.outcome, 'repaired');
    assert.equal(a.evidenceTier, 'permalink-frontmatter');
    assert.equal(a.detail.oldFile, STALE);
    assert.equal(a.detail.newFile, 'src/pages/homepage-v2.njk');
    assert.equal(a.detail.oldEntry.file, STALE);
    assert.equal(a.detail.evidence.permalink, '/');
  });

  test('no matching file: nothing written, audited as not-found, blocked text asks for manual re-mapping', async () => {
    const h = harness({ files: { 'src/pages/about.njk': tpl('/about/') } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'no-match');
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.calls.audits.at(-1).outcome, 'not-found');
    assert.match(staleMappingBlockedReason(PAGE, r), /Manual re-mapping is required/);
  });

  test('multiple matching files: never picks the first, nothing written, candidates listed', async () => {
    const h = harness({ files: { 'src/pages/home-a.njk': tpl('/'), 'src/pages/home-b.njk': tpl("'/'") } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'ambiguous');
    assert.deepEqual(r.candidates, ['src/pages/home-a.njk', 'src/pages/home-b.njk']);
    assert.equal(h.calls.writes.length, 0);
    assert.match(staleMappingBlockedReason(PAGE, r), /home-a\.njk, src\/pages\/home-b\.njk/);
  });

  test('repository API error while listing: unverifiable, nothing written, retried later', async () => {
    const h = harness({ files: {}, fail: { tree: 'GitHub 503' } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'unverifiable');
    assert.equal(h.calls.writes.length, 0);
    assert.match(staleMappingBlockedReason(PAGE, r), /retried on the next pass/);
  });

  test('one template cannot be read: the scan is incomplete, so even a single visible match is NOT trusted', async () => {
    const h = harness({ files: { 'src/pages/homepage-v2.njk': tpl('/'), 'src/pages/other.njk': tpl('/other/') }, fail: { file: 'src/pages/other.njk' } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'unverifiable');
    assert.equal(h.calls.writes.length, 0);
  });

  test('timeout: unverifiable, nothing written', async () => {
    const h = harness({ files: { 'src/pages/homepage-v2.njk': tpl('/') } });
    h.deps.fetchTree = () => new Promise(() => {}); // never answers
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, { ...h.deps, timeoutMs: 20 });
    assert.equal(r.outcome, 'unverifiable');
    assert.match(r.reason, /timed out/);
    assert.equal(h.calls.writes.length, 0);
  });

  test('truncated repository tree: unverifiable', async () => {
    const h = harness({ tree: { files: ['src/pages/homepage-v2.njk'], truncated: true }, files: { 'src/pages/homepage-v2.njk': tpl('/') } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'unverifiable');
    assert.equal(h.calls.writes.length, 0);
  });

  test('the "stale" file is still in the tree: conflicting evidence, never overwrites a mapping that may be valid', async () => {
    const h = harness({ files: { [STALE]: tpl('/old/'), 'src/pages/homepage-v2.njk': tpl('/') } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'unverifiable');
    assert.equal(h.calls.writes.length, 0);
  });

  test('cross-project isolation: a page on another project\'s domain is refused and the repo is never scanned', async () => {
    const h = harness({ files: { 'src/pages/homepage-v2.njk': tpl('/') } });
    const r = await repairStaleFileMapping(h.site, 'https://someone-else.com/', STALE, h.deps);
    assert.equal(r.outcome, 'refused');
    assert.equal(h.calls.fetched.length, 0);
    assert.equal(h.calls.writes.length, 0);
  });

  test('cross-project isolation: the write targets only this site id, and a row that moved repositories aborts it', async () => {
    const ok = harness({ files: { 'src/pages/homepage-v2.njk': tpl('/') } });
    await repairStaleFileMapping(ok.site, PAGE, STALE, ok.deps);
    assert.equal(ok.calls.writes[0].siteId, 1);
    assert.equal(ok.calls.audits.at(-1).siteId, 1);

    const moved = harness({ files: { 'src/pages/homepage-v2.njk': tpl('/') }, live: mkSite({ repo_name: 'a-different-repo' }) });
    const r = await repairStaleFileMapping(moved.site, PAGE, STALE, moved.deps);
    assert.equal(r.outcome, 'unverifiable');
    assert.equal(moved.calls.writes.length, 0);
  });

  test('a mapping fixed by someone else while the repair ran is not overwritten', async () => {
    const live = mkSite({ url_file_map: { pages: { '/': { file: 'src/pages/hand-fixed.njk' } } } });
    const h = harness({ files: { 'src/pages/homepage-v2.njk': tpl('/') }, live });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'refused');
    assert.equal(h.calls.writes.length, 0);
  });

  test('only a mapping that really points at the stale file is touched', async () => {
    const site = mkSite({ url_file_map: { pages: { '/': { file: 'src/pages/other.njk' } } } });
    const h = harness({ site, files: { 'src/pages/homepage-v2.njk': tpl('/') } });
    const r = await repairStaleFileMapping(site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'skipped');
    assert.equal(h.calls.writes.length, 0);
  });

  test('the only candidate is a shared layout: refused, not mapped', async () => {
    const h = harness({ files: { 'src/_includes/home.njk': tpl('/') } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'refused');
    assert.equal(h.calls.writes.length, 0);
  });

  test('the only candidate is already mapped to another URL: refused', async () => {
    const site = mkSite({ url_file_map: { pages: { '/': { file: STALE }, '/landing': { file: 'src/pages/homepage-v2.njk' } } } });
    const h = harness({ site, files: { 'src/pages/homepage-v2.njk': tpl('/') } });
    const r = await repairStaleFileMapping(site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'refused');
    assert.equal(h.calls.writes.length, 0);
  });

  test('template-expression permalinks (pagination) never count as a match', async () => {
    const h = harness({ files: { 'src/pages/loc.njk': tpl('/{{ city }}/') } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'no-match');
  });

  test('AUDIT FAILURE on a repair: the mapping is NOT changed (never an unaudited change) and the block says why', async () => {
    const h = harness({ files: { 'src/pages/homepage-v2.njk': tpl('/') }, fail: { audit: true } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(r.outcome, 'unverifiable');
    assert.match(r.reason, /audit record could not be saved/);
  });

  test('AUDIT FAILURE on a blocked outcome is reported on the finding, not only in a log', async () => {
    const h = harness({ files: { 'src/pages/about.njk': tpl('/about/') }, fail: { audit: true } });
    const r = await repairStaleFileMapping(h.site, PAGE, STALE, h.deps);
    assert.equal(r.outcome, 'no-match');
    assert.equal(r.auditFailed, true);
    assert.match(staleMappingBlockedReason(PAGE, r), /audit record of this attempt could not be saved/);
  });
});
