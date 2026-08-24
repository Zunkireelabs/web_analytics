import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const resolve = (p) => new URL(p, import.meta.url).href;

// This script used to shell out to the `gh` CLI and run a real
// `npm ci && npm run build` of the CLIENT's repo locally to validate a
// patch before opening a PR — safe on a workstation with `gh` authenticated,
// but the production container has neither, so every automated (cron) run
// would have failed outright. Reworked 2026-08-24 to push + PR through the
// same GitHub REST client every other implementer already uses, and rely on
// the client's own CI (the rendering-validation GitHub Actions workflow) to
// validate the build instead — these tests cover that orchestration change.
// The underlying classification logic (classifyCapabilityGap/buildTemplatePatch)
// already has its own thorough test file (agents/lib/template-capability-repair.test.js)
// and is mocked here to keep this file focused on what changed: how the
// script REACTS to a classification result, not how classification itself works.

test('no longer shells out to a CLI at all — the exact class of bug this fix closes', () => {
  // Checked against actual code, not the file's own doc comment explaining
  // what it USED to do (which legitimately still mentions `gh`/npm by name)
  // — real usage would import child_process/execFile or invoke the `gh`
  // binary via execFile(Async)('gh', ...); neither exists anywhere below.
  const source = readFileSync(new URL('./repair-template-capability.js', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /node:child_process|execFile/, 'must never require the gh CLI or a local build again — this is what made every automated run fail in production');
});

let site;
let recs;
let gapResult; // what the mocked classifyCapabilityGap returns
let updateSiteRepoConfigCalls;
let githubCalls; // { createBranch, commitFilesAtomic, openPullRequest } call logs

const realDb = await import(resolve('../db.js'));
mock.module(resolve('../db.js'), {
  namedExports: {
    ...realDb,
    query: async (sql) => {
      if (/FROM recommendations/.test(sql)) return { rows: recs };
      return { rows: [] };
    },
    updateSiteRepoConfig: async (args) => { updateSiteRepoConfigCalls.push(args); return { ...site, url_file_map: args.urlFileMap }; },
  },
});

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});

mock.module(resolve('../github/client.js'), {
  namedExports: {
    getRepoTree: async () => ({ files: ['src/_includes/layouts/service.njk'], truncated: false }),
    getFileContent: async (_s, path) => {
      if (path === 'src/_includes/layouts/service.njk') {
        return { content: '---\npagination:\n  data: servicesShared\nlayout: service.njk\n---\n<div>body</div>', sha: 'abc123' };
      }
      return null;
    },
    getBranchSha: async () => 'base-sha',
    createBranch: async (...a) => { githubCalls.createBranch.push(a); },
    commitFilesAtomic: async (...a) => { githubCalls.commitFilesAtomic.push(a); },
    openPullRequest: async (...a) => { githubCalls.openPullRequest.push(a); return { url: 'https://github.com/acme/site/pull/1', number: 1 }; },
    defaultBranchName: () => 'main',
  },
});

mock.module(resolve('../agents/lib/template-capability-repair.js'), {
  namedExports: {
    classifyCapabilityGap: () => gapResult,
    buildTemplatePatch: (source) => `${source}\n<!-- patched -->`,
    deriveAdapterConfig: (existing, { generatorId, fieldName }) => ({ ...existing, fields: { [fieldName]: fieldName } }),
    GENERATOR_VALUE_KEYS: { 'expand-content': 'expandedContent' },
  },
});

const { repairTemplateCapabilitiesForSite } = await import('./repair-template-capability.js');

function siteFixture() {
  return {
    id: 1, name: 'Acme', repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main',
    url_file_map: {
      patterns: [
        { match: '^/services/([^/]+)/?$', adapters: { 'meta-title': { id: 'data-array-content', dataFile: 'src/_data/servicesShared.js', idField: 'id' } } },
      ],
    },
  };
}

function blockedRec() {
  return { id: 501, page: 'https://acme.com/services/booking/', recommendation_type: 'expand-content', blocked_reason: 'site-fact stuff', blocked_kind: 'site-fact' };
}

beforeEach(() => {
  site = siteFixture();
  recs = [blockedRec()];
  updateSiteRepoConfigCalls = [];
  githubCalls = { createBranch: [], commitFilesAtomic: [], openPullRequest: [] };
  gapResult = { classification: 'safe-capability-gap', siblingLabel: 'src/_includes/layouts/other.njk', siblingSlot: { fieldExpr: 'item.expandedContent', raw: 'slot' }, anchorEnd: 5 };
});

describe('repairTemplateCapabilitiesForSite — orchestration (classification logic is mocked, already tested elsewhere)', () => {
  test('a safe-capability-gap opens a real PR via the GitHub REST client directly — no local build in between', async () => {
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(githubCalls.createBranch.length, 1);
    assert.equal(githubCalls.commitFilesAtomic.length, 1);
    assert.equal(githubCalls.openPullRequest.length, 1);
    assert.equal(report.prsCreated.length, 1);
    assert.equal(report.prsCreated[0].url, 'https://github.com/acme/site/pull/1');
  });

  test('dry-run classifies and reports, but never touches any GitHub write endpoint', async () => {
    const report = await repairTemplateCapabilitiesForSite(1, { dryRun: true });
    assert.equal(githubCalls.createBranch.length, 0);
    assert.equal(githubCalls.commitFilesAtomic.length, 0);
    assert.equal(githubCalls.openPullRequest.length, 0);
    assert.equal(report.prsCreated.length, 0);
    assert.equal(updateSiteRepoConfigCalls.length, 0);
  });

  test('a plumbing-gap (slot already exists, only config is missing) writes url_file_map directly and opens no PR at all', async () => {
    gapResult = { classification: 'plumbing-gap', ownSlot: { fieldExpr: 'item.expandedContent' }, anchorSlots: [] };
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(githubCalls.createBranch.length, 0);
    assert.equal(githubCalls.openPullRequest.length, 0);
    assert.equal(report.prsCreated.length, 0);
    assert.equal(report.plumbingGapsFixed.length, 1);
    assert.equal(updateSiteRepoConfigCalls.length, 1);
  });

  test('an architectural-gap is reported for a human, never guessed at', async () => {
    gapResult = { classification: 'architectural-gap' };
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(report.architecturalGapsBlocked.length, 1);
    assert.equal(githubCalls.createBranch.length, 0);
    assert.equal(updateSiteRepoConfigCalls.length, 0);
  });

  test('an already-wired gap (should not normally happen) is a no-op, not an error', async () => {
    gapResult = { classification: 'already-wired', ownSlot: { fieldExpr: 'item.expandedContent' } };
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(report.plumbingGapsFixed.length, 0);
    assert.equal(report.safeCapabilityGapsRepaired.length, 0);
    assert.equal(report.architecturalGapsBlocked.length, 0);
    assert.equal(githubCalls.createBranch.length, 0);
  });

  test('no blocked recommendations at all is a clean no-op', async () => {
    recs = [];
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(report.prsCreated.length, 0);
    assert.equal(githubCalls.createBranch.length, 0);
  });

  test('a site with no repo connected refuses outright', async () => {
    site.repo_owner = null;
    site.repo_name = null;
    await assert.rejects(() => repairTemplateCapabilitiesForSite(1), /no repo connected/);
  });
});
