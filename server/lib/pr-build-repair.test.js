import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanLog, repoRelative, classifyBuildFailure, planRepair, repairFailingBatchPr, AGENT_BRANCH_PREFIX, REPAIR_SUBJECT_PREFIX } from './pr-build-repair.js';

// The REAL failing log of superrank-web PR 15 (GitHub Actions run 45123439436, 2026-11-23): `gh run view --log-failed` shape, colour codes included.
const REAL_LOG = [
  'Build\tBuild\t2026-11-23T06:20:45.3088074Z ',
  'Build\tBuild\t2026-11-23T06:20:47.6224872Z ^[[2m06:20:47^[[22m ^[[34m[content]^[[39m Syncing content',
  'Build\tBuild\t2026-11-23T06:20:47.8167833Z duplicated mapping key',
  'Build\tBuild\t2026-11-23T06:20:47.8224349Z   ^[[1mLocation:^[[22m',
  'Build\tBuild\t2026-11-23T06:20:47.8258139Z     ^[[4m/home/runner/work/superrank-web/superrank-web/src/content/blog/a-60-day-plan-to-grow-ai-search-visibility.md:5:0^[[24m',
  'Build\tBuild\t2026-11-23T06:20:47.8297048Z   ^[[1mStack trace:^[[22m',
  'Build\tBuild\t2026-11-23T06:20:47.8318005Z ^[[2m    at generateError (file:///home/runner/work/superrank-web/superrank-web/node_modules/js-yaml/dist/js-yaml.mjs:1140:12)',
].join('\n');
// The second failure that sat behind it (local `astro build`, same Astro): a generated post the content schema rejects.
const SCHEMA_LOG = [
  '[InvalidContentEntryDataError] blog → can-you-track-your-brand-in-chatgpt-and-perplexity-a-complete-guide data does not match collection schema.',
  '  excerpt**: **excerpt: Required',
  '  author**: **author: Did not match union.',
  '  Location:',
  '    /home/runner/work/superrank-web/superrank-web/src/content/blog/can-you-track-your-brand-in-chatgpt-and-perplexity-a-complete-guide.md:0:0',
].join('\n');
const DUP = 'src/content/blog/a-60-day-plan-to-grow-ai-search-visibility.md';
const NEWPOST = 'src/content/blog/can-you-track-your-brand-in-chatgpt-and-perplexity-a-complete-guide.md';

describe('reading a build log', () => {
  test('cleanLog drops the job columns, timestamps and colour codes', () => {
    const c = cleanLog(REAL_LOG);
    assert.doesNotMatch(c, /2026-11-23T/);
    assert.doesNotMatch(c, /\^\[\[|\u001b\[/);
    assert.match(c, /^duplicated mapping key$/m);
  });
  test('repoRelative turns a runner path into a repository path', () => {
    assert.equal(repoRelative('/home/runner/work/superrank-web/superrank-web/src/content/blog/a.md:5:0'), 'src/content/blog/a.md');
    assert.equal(repoRelative('./src/app/page.tsx'), 'src/app/page.tsx');
    assert.equal(repoRelative('src/a.njk'), 'src/a.njk');
  });
  test('the real PR 15 log is a duplicate front-matter key in the PR\'s own post', () => {
    const f = classifyBuildFailure(REAL_LOG, [DUP, 'src/content/blog/other.md'], { repoName: 'superrank-web' });
    assert.equal(f.kind, 'duplicate-front-matter-key');
    assert.deepEqual(f.files, [DUP]);
    assert.match(f.excerpt, /duplicated mapping key/);
  });
  test('a schema rejection is its own kind and names the new post', () => {
    const f = classifyBuildFailure(SCHEMA_LOG, [NEWPOST], { repoName: 'superrank-web' });
    assert.equal(f.kind, 'content-schema');
    assert.deepEqual(f.files, [NEWPOST]);
  });
  test('a file the PR did not change is mentioned but never listed as the PR\'s own', () => {
    const f = classifyBuildFailure(REAL_LOG, ['src/content/blog/unrelated.md'], { repoName: 'superrank-web' });
    assert.deepEqual(f.files, []);
    assert.ok(f.mentioned.includes(DUP));
  });
  test('Next.js style output: the file after "./" in a compile error', () => {
    const f = classifyBuildFailure('Failed to compile.\n\n./src/app/birgunj/page.tsx\nType error: Property \'x\' does not exist.\n', ['src/app/birgunj/page.tsx']);
    assert.equal(f.kind, 'compile-error');
    assert.deepEqual(f.files, ['src/app/birgunj/page.tsx']);
  });
  test('a log it does not understand is unknown and names nothing', () => {
    const f = classifyBuildFailure('npm ERR! network timeout\nnpm ERR! A complete log is in /root/.npm/_logs', ['src/a.md']);
    assert.deepEqual([f.kind, f.files], ['unknown', []]);
  });
});

describe('planRepair — the smallest safe change', () => {
  const dupHead = '---\ntitle: "New"\nexcerpt: "New e"\n\ntitle: "Old"\nexcerpt: "Old e"\ndate: 2026-01-01\n---\nBody\n';
  test('a duplicated key is repaired in place, keeping the first', () => {
    const p = planRepair({ kind: 'duplicate-front-matter-key', files: [DUP], mentioned: [DUP] }, [{ path: DUP, status: 'modified', headContent: dupHead, baseContent: '---\ntitle: "Old"\n---\nBody' }]);
    assert.equal(p.status, 'repair');
    assert.equal(p.actions[0].op, 'rewrite');
    assert.match(p.actions[0].content, /^title: "New"$/m);
    assert.doesNotMatch(p.actions[0].content, /Old/);
    assert.match(p.actions[0].content, /^date: 2026-01-01$/m);
    assert.match(p.actions[0].content, /Body/);
  });
  test('a new file the build rejects is taken out of the PR (held, not lost)', () => {
    const p = planRepair({ kind: 'content-schema', files: [NEWPOST], mentioned: [NEWPOST] }, [{ path: NEWPOST, status: 'added', headContent: 'x', baseContent: null }]);
    assert.equal(p.status, 'hold');
    assert.deepEqual(p.actions.map((a) => [a.op, a.path]), [['delete', NEWPOST]]);
  });
  test('an edited file the build rejects goes back to what the base branch has', () => {
    const p = planRepair({ kind: 'compile-error', files: ['src/a.tsx'], mentioned: ['src/a.tsx'] }, [{ path: 'src/a.tsx', status: 'modified', headContent: 'broken', baseContent: 'ok' }]);
    assert.deepEqual(p.actions.map((a) => [a.op, a.content]), [['revert', 'ok']]);
  });
  test('a duplicate key it cannot repair falls back to putting the file back', () => {
    const p = planRepair({ kind: 'duplicate-front-matter-key', files: ['a.md'], mentioned: ['a.md'] }, [{ path: 'a.md', status: 'modified', headContent: '---\ntitle: "x"\n---\n', baseContent: 'base' }]);
    assert.equal(p.actions[0].op, 'revert');
  });
  test('a failure that names none of the PR\'s files changes nothing', () => {
    assert.deepEqual(planRepair({ kind: 'compile-error', files: [], mentioned: ['src/other.tsx'] }, []), { status: 'not-ours', actions: [] });
    assert.deepEqual(planRepair({ kind: 'unknown', files: [], mentioned: [] }, []), { status: 'unknown', actions: [] });
  });
  test('no base content to revert to and not a new file: nothing is guessed', () => {
    assert.equal(planRepair({ kind: 'compile-error', files: ['a.tsx'], mentioned: ['a.tsx'] }, [{ path: 'a.tsx', status: 'modified', headContent: 'x', baseContent: null }]).status, 'unknown');
  });
});

describe('repairFailingBatchPr — the loop on one PR', () => {
  const site = { id: 8871, repo_owner: 'o', repo_name: 'superrank-web' };
  const pr = (o = {}) => ({ state: 'open', merged: false, headRef: `${AGENT_BRANCH_PREFIX}8871-2026-11-22`, headSha: 'abc', base: 'main', ...o });
  const dupHead = '---\ntitle: "New"\n\ntitle: "Old"\ndate: 2026-01-01\n---\nBody\n';
  const mk = (o = {}) => {
    const calls = { commits: [] };
    return { calls, deps: {
      getPullRequest: async () => o.pr || pr(),
      getCheckRunsDetailedForRef: async () => o.runs || [{ id: 9, name: 'Build', status: 'completed', conclusion: 'failure', url: 'u' }],
      listCommitSubjectsAheadOfBase: async () => o.subjects || ['Action Center: batch'],
      listPullRequestFiles: async () => o.files || [{ path: DUP, status: 'modified' }],
      getJobLogText: async () => o.log ?? REAL_LOG,
      getFileContent: async (_s, path, ref) => ({ content: ref === 'main' ? '---\ntitle: "Old"\n---\nBody' : dupHead }),
      commitFilesAtomic: async (_s, branch, files, message) => { calls.commits.push({ branch, files, message }); return { sha: 'newsha' }; },
    } };
  };

  test('a PR on a branch the agent does not own is never touched', async () => {
    const r = await repairFailingBatchPr(site, 1, { apply: true, deps: mk({ pr: pr({ headRef: 'feature/someone-else' }) }).deps });
    assert.equal(r.outcome, 'skipped');
  });
  test('a closed or merged PR is skipped', async () => {
    assert.equal((await repairFailingBatchPr(site, 1, { deps: mk({ pr: pr({ merged: true, state: 'closed' }) }).deps })).outcome, 'skipped');
  });
  test('a running check means wait; a green build means nothing to do', async () => {
    assert.equal((await repairFailingBatchPr(site, 1, { deps: mk({ runs: [{ id: 1, name: 'Build', status: 'in_progress', conclusion: null }] }).deps })).outcome, 'pending');
    assert.equal((await repairFailingBatchPr(site, 1, { deps: mk({ runs: [{ id: 1, name: 'Build', status: 'completed', conclusion: 'success' }] }).deps })).outcome, 'green');
  });
  test('the default is a dry run: it plans the repair and writes nothing', async () => {
    const m = mk();
    const r = await repairFailingBatchPr(site, 15, { deps: m.deps });
    assert.equal(r.outcome, 'planned');
    assert.equal(r.plan.actions[0].op, 'rewrite');
    assert.equal(m.calls.commits.length, 0);
  });
  test('apply pushes ONE commit to the PR\'s own branch with the repaired file and says why', async () => {
    const m = mk();
    const r = await repairFailingBatchPr(site, 15, { apply: true, deps: m.deps });
    assert.equal(r.outcome, 'repaired');
    assert.equal(m.calls.commits.length, 1);
    const c = m.calls.commits[0];
    assert.equal(c.branch, `${AGENT_BRANCH_PREFIX}8871-2026-11-22`);
    assert.deepEqual(c.files.map((f) => f.path), [DUP]);
    assert.doesNotMatch(c.files[0].content, /Old/);
    assert.ok(c.message.startsWith(REPAIR_SUBJECT_PREFIX));
    assert.match(c.message, /duplicate-front-matter-key/);
  });
  test('a schema-rejected NEW post is removed from the PR and the outcome says it was held', async () => {
    const m = mk({ log: SCHEMA_LOG, files: [{ path: NEWPOST, status: 'added' }] });
    const r = await repairFailingBatchPr(site, 15, { apply: true, deps: m.deps });
    assert.equal(r.outcome, 'held');
    assert.deepEqual(m.calls.commits[0].files, [{ path: NEWPOST, delete: true }]);
  });
  test('two repair commits already on the branch and still red: it stops and asks for a person', async () => {
    const m = mk({ subjects: [`${REPAIR_SUBJECT_PREFIX} rewrite a`, `${REPAIR_SUBJECT_PREFIX} revert b`] });
    const r = await repairFailingBatchPr(site, 15, { apply: true, deps: m.deps });
    assert.equal(r.outcome, 'gave-up');
    assert.equal(m.calls.commits.length, 0);
  });
  test('a red build that names none of the PR\'s files is reported, not touched', async () => {
    const m = mk({ files: [{ path: 'src/content/blog/unrelated.md', status: 'modified' }] });
    const r = await repairFailingBatchPr(site, 15, { apply: true, deps: m.deps });
    assert.equal(r.outcome, 'not-ours');
    assert.equal(m.calls.commits.length, 0);
  });
  test('a log it cannot read is reported as unknown and nothing is pushed', async () => {
    const m = mk({ log: 'npm ERR! network timeout' });
    const r = await repairFailingBatchPr(site, 15, { apply: true, deps: m.deps });
    assert.equal(r.outcome, 'unknown');
    assert.equal(m.calls.commits.length, 0);
  });
});
