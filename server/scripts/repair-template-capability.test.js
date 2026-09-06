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
let existingPrsForBranch; // what listOpenPullRequestsForBranch returns — [] unless a test sets otherwise

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

// Mutable per-test override for the data file's content — null (the
// default) matches every pre-existing test's expectation that the data
// file can't be read; tests that need to exercise the live
// capability-repair execution path set this explicitly.
let dataFileContentOverride = null;
mock.module(resolve('../github/client.js'), {
  namedExports: {
    getRepoTree: async () => ({ files: ['src/_includes/layouts/service.njk'], truncated: false }),
    getFileContent: async (_s, path) => {
      if (path === 'src/_includes/layouts/service.njk') {
        return { content: '---\npagination:\n  data: servicesShared\nlayout: service.njk\n---\n<div>body</div>', sha: 'abc123' };
      }
      if (path === 'src/_data/servicesShared.js' && dataFileContentOverride != null) {
        return { content: dataFileContentOverride, sha: 'data-sha' };
      }
      return null;
    },
    getBranchSha: async () => 'base-sha',
    createBranch: async (...a) => { githubCalls.createBranch.push(a); },
    commitFilesAtomic: async (...a) => { githubCalls.commitFilesAtomic.push(a); },
    openPullRequest: async (...a) => { githubCalls.openPullRequest.push(a); return { url: 'https://github.com/acme/site/pull/1', number: 1 }; },
    listOpenPullRequestsForBranch: async (...a) => { githubCalls.listOpenPullRequestsForBranch.push(a); return existingPrsForBranch; },
    defaultBranchName: () => 'main',
  },
});

const realTemplateCapabilityRepair = await import(resolve('../agents/lib/template-capability-repair.js'));
mock.module(resolve('../agents/lib/template-capability-repair.js'), {
  namedExports: {
    classifyCapabilityGap: () => gapResult,
    buildTemplatePatch: (source) => `${source}\n<!-- patched -->`,
    deriveAdapterConfig: (existing, { generatorId, fieldName }) => ({ ...existing, fields: { [fieldName]: fieldName } }),
    getGeneratorValueKey: (generatorId) => ({ 'expand-content': 'expandedContent' }[generatorId] ?? null),
    // Real implementations (pure, no I/O) — findConventionExamples (this
    // script's own architectural-gap evidence gathering) and the live
    // capability-repair execution path call these for real against the
    // mocked getFileContent fixture content above, same as production;
    // only the DB/GitHub/Design-Agent/classification boundary is mocked.
    parseAiManagedSlots: realTemplateCapabilityRepair.parseAiManagedSlots,
    findSlotForGenerator: realTemplateCapabilityRepair.findSlotForGenerator,
    fieldNameFromExpr: realTemplateCapabilityRepair.fieldNameFromExpr,
  },
});

// capabilityRepairJobResult: what the queued capability-repair job's row
// resolves to once "claimed and run" (or an Error, for a failed job) —
// stands in for design-agent-worker's own separate process actually
// completing it, which this script now waits on by polling the job row
// (see repair-template-capability.js's runCapabilityRepairJob) instead of
// calling openhands-handler.js's handler in-process (2026-08-25: that
// in-process call was a real, currently-live bug — this script's own
// container has neither the Python nor the Docker access that handler
// needs, only design-agent-worker's container does).
let capabilityRepairJobResult;
let capabilityRepairCalls; // { siteId, payload } per createDesignAgentJob call
const realExecutionJobs = await import(resolve('../store/execution-jobs.js'));
mock.module(resolve('../store/execution-jobs.js'), {
  namedExports: {
    ...realExecutionJobs,
    // Resolves 'completed'/'failed' on the very first poll — this script's
    // own polling loop treats any non-queued/non-executing status as done,
    // so there is nothing to wait out here; a real deployment's wait is
    // exercised separately by design-drift.test.js's equivalent coverage of
    // the same waitForCompletion pattern this mirrors.
    createDesignAgentJob: async (siteId, recommendationId, { params } = {}) => {
      capabilityRepairCalls.push({ siteId, payload: params?.payload });
      return { id: 1 };
    },
    getDesignAgentJobById: async (jobId) => (
      capabilityRepairJobResult instanceof Error
        ? { id: jobId, status: 'failed', result: { failure: { message: capabilityRepairJobResult.message } } }
        : { id: jobId, status: 'completed', result: capabilityRepairJobResult }
    ),
  },
});

let capabilityRepairRecordCalls;
mock.module(resolve('../store/capability-repairs.js'), {
  namedExports: {
    recordCapabilityRepair: async (...a) => { capabilityRepairRecordCalls.push(a); },
  },
});

// resolvedPageMappings: Set of page URLs resolveFile should report as
// already-mapped (via url_file_map.pages, independent of the patterns
// array every other mock/fixture here concerns itself with). autoHealCalls/
// autoHealResult: PASS 0's own real dependency, mocked separately so tests
// can exercise "already resolved", "heals successfully", and "heal cannot
// resolve it" without needing a real repo/GitHub call graph.
let resolvedPageMappings;
let autoHealCalls;
let autoHealResult; // page -> truthy (healed) | falsy (not healed), or a function(page)
// resolvedContentTargets: Set of actionType strings resolveNewContentTarget
// should report as already-configured, independent of resolvedPageMappings
// above — a completely separate capability (newContentTargets vs. pages).
let resolvedContentTargets;
let autoHealContentTargetCalls;
let autoHealContentTargetResult; // actionType -> truthy (healed) | falsy, or a function(actionType)
mock.module(resolve('../implementers/lib/url-file-map.js'), {
  namedExports: {
    resolveFile: (_site, page) => (resolvedPageMappings.has(page) ? { file: 'already-mapped.njk' } : null),
    resolveNewContentTarget: (_site, actionType) => (resolvedContentTargets.has(actionType) ? `content/${actionType}.md` : null),
  },
});
mock.module(resolve('../implementers/lib/discover-file-mapping.js'), {
  namedExports: {
    autoHealFileMapping: async (_site, page) => {
      autoHealCalls.push(page);
      const result = typeof autoHealResult === 'function' ? autoHealResult(page) : autoHealResult;
      if (result) resolvedPageMappings.add(page); // mirrors the real function's own persisted effect
      return result || null;
    },
  },
});
mock.module(resolve('../implementers/frontend.js'), {
  namedExports: {
    FRONTEND_ACTION_TYPES: new Set(['landing-page', 'blog-outline', 'direct-answer', 'translation', 'cookie-policy', 'privacy-policy', 'terms-of-service']),
  },
});
mock.module(resolve('../implementers/lib/discover-content-target.js'), {
  namedExports: {
    autoHealNewContentTarget: async (_site, actionType) => {
      autoHealContentTargetCalls.push(actionType);
      const result = typeof autoHealContentTargetResult === 'function' ? autoHealContentTargetResult(actionType) : autoHealContentTargetResult;
      if (result) resolvedContentTargets.add(actionType);
      return result || null;
    },
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
  githubCalls = { createBranch: [], commitFilesAtomic: [], openPullRequest: [], listOpenPullRequestsForBranch: [] };
  existingPrsForBranch = [];
  gapResult = { classification: 'safe-capability-gap', siblingLabel: 'src/_includes/layouts/other.njk', siblingSlot: { fieldExpr: 'item.expandedContent', raw: 'slot' }, anchorEnd: 5 };
  capabilityRepairJobResult = null;
  capabilityRepairCalls = [];
  capabilityRepairRecordCalls = [];
  dataFileContentOverride = null;
  resolvedPageMappings = new Set();
  autoHealCalls = [];
  autoHealResult = null;
  resolvedContentTargets = new Set();
  autoHealContentTargetCalls = [];
  autoHealContentTargetResult = null;
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

  // The branch this opens onto is date-scoped, not per-run — a second
  // capability-repair fix landing the same calendar day must commit onto
  // the SAME branch as an earlier one and reuse ITS already-open PR,
  // never call openPullRequest a second time (GitHub 422s "a pull request
  // already exists for ..." on that, which would previously crash the
  // whole run AFTER the new commit had already landed, before this
  // function ever reached its own url_file_map DB write below).
  test('reuses an already-open PR for today\'s branch instead of opening a second one', async () => {
    existingPrsForBranch = [{ number: 7, html_url: 'https://github.com/acme/site/pull/7' }];
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(githubCalls.createBranch.length, 1, 'createBranch is still called — it no-ops on "already exists"');
    assert.equal(githubCalls.commitFilesAtomic.length, 1, 'the new fix still gets committed onto the existing branch');
    assert.equal(githubCalls.openPullRequest.length, 0, 'never opens a second PR for the same branch');
    assert.equal(report.prsCreated.length, 1);
    assert.equal(report.prsCreated[0].url, 'https://github.com/acme/site/pull/7');
    assert.equal(report.prsCreated[0].number, 7);
    assert.equal(report.prsCreated[0].reused, true);
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

describe('repairTemplateCapabilitiesForSite — live architectural-gap execution (capability-repair Design Agent job)', () => {
  const TEMPLATE_BEFORE = '---\npagination:\n  data: servicesShared\nlayout: service.njk\n---\n<div>body</div>';
  const TEMPLATE_AFTER = `${TEMPLATE_BEFORE}\n{# see server/generators/expand-content.js #}\n{% if item.expandedContent %}\n{{ item.expandedContent | safe }}\n{% endif %}\n`;
  const DATA_BEFORE = 'export default [{ id: "a" }]';
  const DATA_AFTER = 'export default [{ id: "a", expandedContent: \'\' }]';

  beforeEach(() => {
    gapResult = { classification: 'architectural-gap' };
    dataFileContentOverride = DATA_BEFORE;
    site.auto_remediation_enabled = true;
  });

  test('a validated repair folds both file edits into the SAME PR as any other gap — no separate PR of its own', async () => {
    capabilityRepairJobResult = {
      filesChanged: [
        { path: 'src/_includes/layouts/service.njk', newContent: TEMPLATE_AFTER },
        { path: 'src/_data/servicesShared.js', newContent: DATA_AFTER },
      ],
    };
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(report.architecturalGapsRepaired.length, 1);
    assert.equal(report.architecturalGapsRepaired[0].fieldName, 'expandedContent');
    assert.equal(report.architecturalGapsBlocked.length, 0);
    // Exactly ONE PR for the whole run, covering both files — not a second,
    // separate PR "merely because a capability repair was performed".
    assert.equal(githubCalls.openPullRequest.length, 1);
    assert.equal(githubCalls.commitFilesAtomic.length, 1);
    const [, , files] = githubCalls.commitFilesAtomic[0];
    assert.deepEqual(files.map((f) => f.path).sort(), ['src/_data/servicesShared.js', 'src/_includes/layouts/service.njk']);
    assert.equal(updateSiteRepoConfigCalls.length, 1);
    assert.equal(capabilityRepairRecordCalls.length, 1);
    assert.equal(capabilityRepairRecordCalls[0][1].outcome, 'repaired');
  });

  test('never trusts the agent\'s own self-report — a returned template with no genuinely NEW slot is refused, not repaired', async () => {
    capabilityRepairJobResult = {
      // Agent claims success but the returned template is IDENTICAL to
      // before — no real slot was added.
      filesChanged: [
        { path: 'src/_includes/layouts/service.njk', newContent: TEMPLATE_BEFORE },
        { path: 'src/_data/servicesShared.js', newContent: DATA_AFTER },
      ],
    };
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(report.architecturalGapsRepaired.length, 0);
    assert.equal(report.architecturalGapsBlocked.length, 1);
    assert.match(report.architecturalGapsBlocked[0].reason, /could not be independently verified/);
    assert.equal(githubCalls.openPullRequest.length, 0);
    assert.equal(updateSiteRepoConfigCalls.length, 0);
    assert.equal(capabilityRepairRecordCalls[0][1].outcome, 'failed');
  });

  test('a job that throws (sandbox/build failure) is reported and recorded as failed, never guessed past', async () => {
    capabilityRepairJobResult = new Error('client build failed');
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(report.architecturalGapsRepaired.length, 0);
    assert.equal(report.architecturalGapsBlocked.length, 1);
    assert.match(report.architecturalGapsBlocked[0].reason, /client build failed/);
    assert.equal(githubCalls.openPullRequest.length, 0);
    assert.equal(capabilityRepairRecordCalls[0][1].outcome, 'failed');
  });

  test('dry-run never invokes a real capability-repair job at all', async () => {
    const report = await repairTemplateCapabilitiesForSite(1, { dryRun: true });
    assert.equal(capabilityRepairCalls.length, 0);
    assert.equal(report.architecturalGapsWithDerivedTask.length, 1);
    assert.equal(githubCalls.openPullRequest.length, 0);
  });

  test('a site that has never granted auto-remediation consent stays blocked, no job dispatched', async () => {
    site.auto_remediation_enabled = false;
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(capabilityRepairCalls.length, 0);
    assert.equal(report.architecturalGapsRepaired.length, 0);
    assert.equal(report.architecturalGapsBlocked.length, 1);
    assert.match(report.architecturalGapsBlocked[0].reason, /auto_remediation_enabled is off/);
    assert.equal(githubCalls.openPullRequest.length, 0);
  });

  // Two-stage onboarding: connect-repo grants auto_remediation_enabled AND
  // queues the whole-site analysis job, but repair execution must still wait
  // for that analysis to finish — auto_remediation_enabled alone is not
  // sufficient the very same pass a brand-new tenant connects.
  describe('two-stage onboarding — repair waits for the analysis job, not just auto_remediation_enabled', () => {
    test('onboarding analysis still pending -> stays blocked, no job dispatched, even though auto_remediation_enabled is true', async () => {
      const report = await repairTemplateCapabilitiesForSite(1, { onboardingAnalysisPending: async () => true });
      assert.equal(capabilityRepairCalls.length, 0);
      assert.equal(report.architecturalGapsRepaired.length, 0);
      assert.equal(report.architecturalGapsBlocked.length, 1);
      assert.match(report.architecturalGapsBlocked[0].reason, /onboarding analysis is still in progress/);
      assert.equal(githubCalls.openPullRequest.length, 0);
    });

    test('dry-run also reports honestly that onboarding analysis is pending, not "would queue"', async () => {
      const report = await repairTemplateCapabilitiesForSite(1, { dryRun: true, onboardingAnalysisPending: async () => true });
      assert.equal(capabilityRepairCalls.length, 0);
      assert.equal(report.architecturalGapsWithDerivedTask.length, 0);
      assert.equal(report.architecturalGapsBlocked.length, 1);
      assert.match(report.architecturalGapsBlocked[0].reason, /onboarding analysis is still in progress/);
    });

    test('onboarding analysis terminal (not pending) -> proceeds to the normal live repair path', async () => {
      capabilityRepairJobResult = {
        filesChanged: [
          { path: 'src/_includes/layouts/service.njk', newContent: TEMPLATE_AFTER },
          { path: 'src/_data/servicesShared.js', newContent: DATA_AFTER },
        ],
      };
      const report = await repairTemplateCapabilitiesForSite(1, { onboardingAnalysisPending: async () => false });
      assert.equal(report.architecturalGapsRepaired.length, 1);
      assert.equal(report.architecturalGapsBlocked.length, 0);
      assert.equal(capabilityRepairCalls.length, 1);
    });

    test('the onboarding-pending check runs once per site call, not once per gap (checked via call count)', async () => {
      let calls = 0;
      await repairTemplateCapabilitiesForSite(1, { onboardingAnalysisPending: async () => { calls++; return true; } });
      assert.equal(calls, 1);
    });
  });
});

describe('repairTemplateCapabilitiesForSite — Pass 0: page-level file-mapping auto-heal', () => {
  // A page that matches NO url_file_map pattern at all — the exact real
  // bug this pass fixes: matchingPatternIndex only ever checked `patterns`,
  // never `pages`, so a page resolvable (or resolvable-via-heal) only
  // through `pages` was reported as an unconditional "needs a human"
  // architectural gap regardless.
  function unmappedPageRec() {
    return { id: 601, page: 'https://acme.com/about/', recommendation_type: 'faq', blocked_reason: 'no mapping', blocked_kind: 'our-config' };
  }

  test('a page already resolvable via url_file_map.pages is never sent to autoHealFileMapping, and is not reported as blocked', async () => {
    recs = [unmappedPageRec()];
    resolvedPageMappings.add('https://acme.com/about/');
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(autoHealCalls.length, 0);
    assert.equal(report.architecturalGapsBlocked.length, 0);
    assert.deepEqual(report.pageMappingsHealed, []);
  });

  test('a genuinely unmapped page is healed via the real autoHealFileMapping (mocked), and is not reported as blocked', async () => {
    recs = [unmappedPageRec()];
    autoHealResult = { url_file_map: {} }; // truthy = "healed", matching autoHealFileMapping's real return shape
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.deepEqual(autoHealCalls, ['https://acme.com/about/']);
    assert.deepEqual(report.pageMappingsHealed, ['https://acme.com/about/']);
    assert.equal(report.architecturalGapsBlocked.length, 0);
  });

  test('a page whose file already resolves is never reported blocked, even when it matches a pattern with no relevant adapter', async () => {
    // Real bug this guards against: a page can match a PATTERN registered
    // for a completely unrelated generatorId's adapter while its own file
    // resolves through a totally different, adapter-free path (a plain
    // per-file marker splice) — the pattern match must not be mistaken for
    // "this generator needs an adapter that doesn't exist".
    gapResult = { classification: 'architectural-gap' };
    recs = [blockedRec()]; // matches the '^/services/([^/]+)/?$' pattern, which has only a meta-title adapter
    resolvedPageMappings.add('https://acme.com/services/booking/');
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.equal(report.architecturalGapsBlocked.length, 0);
    assert.equal(autoHealCalls.length, 0);
  });

  test('a net-new-content generatorId (FRONTEND_ACTION_TYPES) healed via autoHealNewContentTarget is not reported as blocked', async () => {
    recs = [{ id: 701, page: 'some-topic-slug', recommendation_type: 'blog-outline', blocked_reason: 'no content target', blocked_kind: 'our-config' }];
    autoHealContentTargetResult = { url_file_map: {} };
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.deepEqual(autoHealContentTargetCalls, ['blog-outline']);
    assert.deepEqual(report.contentTargetsHealed, ['blog-outline']);
    assert.equal(report.architecturalGapsBlocked.length, 0);
  });

  test('a non-net-new generatorId (e.g. faq) never triggers autoHealNewContentTarget at all — never applied where it could be wrong', async () => {
    recs = [unmappedPageRec()]; // recommendation_type: 'faq', not in FRONTEND_ACTION_TYPES
    autoHealContentTargetResult = { url_file_map: {} }; // would "succeed" if ever called — must not be
    autoHealResult = null; // page mapping genuinely unresolvable, so the group still reports blocked
    await repairTemplateCapabilitiesForSite(1);
    assert.equal(autoHealContentTargetCalls.length, 0);
  });

  test('a net-new-content generatorId autoHealNewContentTarget genuinely cannot resolve stays honestly blocked', async () => {
    recs = [{ id: 702, page: 'another-topic', recommendation_type: 'blog-outline', blocked_reason: 'no content target', blocked_kind: 'our-config' }];
    autoHealContentTargetResult = null; // ambiguous/not-found, autoHealNewContentTarget's own real refusal
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.deepEqual(autoHealContentTargetCalls, ['blog-outline']);
    assert.equal(report.contentTargetsHealed.length, 0);
    assert.equal(report.architecturalGapsBlocked.length, 1);
  });

  test('dry-run never calls autoHealNewContentTarget (no writes)', async () => {
    recs = [{ id: 703, page: 'yet-another-topic', recommendation_type: 'blog-outline', blocked_reason: 'no content target', blocked_kind: 'our-config' }];
    autoHealContentTargetResult = { url_file_map: {} };
    await repairTemplateCapabilitiesForSite(1, { dryRun: true });
    assert.equal(autoHealContentTargetCalls.length, 0);
  });

  test('a page autoHealFileMapping genuinely cannot resolve (ambiguous/foreign-domain/etc) stays honestly blocked, never guessed past', async () => {
    recs = [unmappedPageRec()];
    autoHealResult = null; // autoHealFileMapping's own real return when it refuses/can't resolve
    const report = await repairTemplateCapabilitiesForSite(1);
    assert.deepEqual(autoHealCalls, ['https://acme.com/about/']);
    assert.equal(report.pageMappingsHealed.length, 0);
    assert.equal(report.architecturalGapsBlocked.length, 1);
    assert.match(report.architecturalGapsBlocked[0].reason, /autoHealFileMapping could not safely resolve/);
  });

  test('dry-run never calls autoHealFileMapping (no writes) but still reports the gap honestly', async () => {
    recs = [unmappedPageRec()];
    autoHealResult = { url_file_map: {} }; // would heal on a live run — must NOT be invoked here
    const report = await repairTemplateCapabilitiesForSite(1, { dryRun: true });
    assert.equal(autoHealCalls.length, 0);
    assert.equal(report.pageMappingsHealed.length, 0);
  });
});
