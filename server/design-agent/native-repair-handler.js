// Native (no Docker, no OpenHands) replacements for openhands-handler.js's
// createCapabilityRepairHandler / createCodeSelfRepairHandler. Same input
// shape, same output shape ({ jobId, testsPassed, testOutput, patch,
// filesChanged, summary, ... }) as the handlers they replace — every
// downstream caller (server/scripts/repair-template-capability.js's
// runCapabilityRepairJob, server/agents/lib/code-self-repair.js's
// investigateAndRepair) needs zero changes to keep working, since both
// already only ever consume this generic result shape, never anything
// OpenHands-specific.
import { checkoutIntoSandbox, destroySandbox, snapshotFiles, listSandboxFiles, runSandboxCommand } from './native-repair/sandbox.js';
import { runAgentLoop } from './native-repair/agent-loop.js';
import { buildCapabilityRepairPrompt, validateCapabilityRepair } from './native-repair/capability-repair-task.js';
import { buildCodeSelfRepairPrompt, validateCodeSelfRepair } from './native-repair/code-self-repair-task.js';
import { getSiteById } from '../store/read.js';

const CAPABILITY_REPAIR_SYSTEM = 'You are a careful, minimal-diff software engineer working inside a real client website repository. '
  + 'Only make the exact change requested. Never touch a file you were not told to touch.';
const CODE_SELF_REPAIR_SYSTEM = 'You are a careful, minimal-diff software engineer fixing a real bug in a production analytics platform\'s '
  + 'own codebase. Only make the exact change the bug requires. Never touch a file outside the scope you were given.';

function taggedError(message, stage) {
  const err = new Error(message);
  err.stage = stage;
  return err;
}

// job: an execution_jobs row (worker.js's dispatchingHandler), with
// job.site_id + job.params.payload — the exact shape
// runCapabilityRepairJob's createDesignAgentJob(siteId, null, { params:
// { mode: 'capability-repair', payload } }) already produces.
export function createNativeCapabilityRepairHandler({ getSiteByIdFn = getSiteById, checkoutIntoSandboxFn = checkoutIntoSandbox } = {}) {
  return async function nativeCapabilityRepairHandler(job) {
    const payload = job.params?.payload || {};
    const { templatePath, dataFilePath } = payload;
    if (!templatePath || !dataFilePath) {
      throw taggedError('capability-repair job is missing templatePath/dataFilePath.', 'input_validation');
    }

    const site = await getSiteByIdFn(job.site_id).catch((err) => {
      throw taggedError(`Could not load site ${job.site_id}: ${err.message}`, 'input_validation');
    });
    if (!site) throw taggedError(`Site ${job.site_id} no longer exists.`, 'input_validation');

    let sandbox;
    try {
      sandbox = await checkoutIntoSandboxFn(site, { ref: site.repo_default_branch }).catch((err) => {
        const wrapped = taggedError(`Could not check out this site's repository: ${err.message}`, 'repo_checkout');
        wrapped.code = err.code || null;
        throw wrapped;
      });

      const allFiles = await listSandboxFiles(sandbox, '.');
      const before = await snapshotFiles(sandbox, [...new Set([...allFiles, templatePath, dataFilePath])]);
      const result = await runAgentLoop({
        systemPrompt: CAPABILITY_REPAIR_SYSTEM,
        taskPrompt: buildCapabilityRepairPrompt(payload),
        sandbox,
        allowlist: ['npm', 'pnpm', 'yarn', 'node'],
        fileAllowlist: [templatePath, dataFilePath],
        validate: () => validateCapabilityRepair(sandbox, { templatePath, dataFilePath }, before),
      });

      if (result.status !== 'ok') {
        throw taggedError(result.detail || 'capability-repair agent did not produce a validated result.', 'result_validation');
      }
      return {
        jobId: job.id, detail: result.summary || null, summary: result.summary || null,
        fieldName: result.fieldName || null, baseVar: result.baseVar || null,
        testsPassed: result.testsPassed === true, testOutput: result.testOutput || null,
        patch: result.patch || null, filesChanged: result.filesChanged || [],
      };
    } finally {
      await destroySandbox(sandbox);
    }
  };
}

// job: whatever code-self-repair.js's investigateAndRepair already builds —
// { id, repo: PLATFORM_REPO, generatorId, reason, errorMessage,
// occurrenceDays, testFileHint }. Called directly, in-process (never
// through the execution_jobs queue) — matches how the OpenHands handler it
// replaces was already being invoked.
export function createNativeCodeSelfRepairHandler({
  getRepoDefaultBranch = (repo) => repo.repo_default_branch, checkoutIntoSandboxFn = checkoutIntoSandbox,
} = {}) {
  return async function nativeCodeSelfRepairHandler(job) {
    const { repo, generatorId, reason, errorMessage, occurrenceDays, testFileHint } = job;
    if (!repo?.repo_owner || !repo?.repo_name) {
      throw taggedError('code-self-repair job is missing a repo descriptor.', 'input_validation');
    }

    let sandbox;
    try {
      sandbox = await checkoutIntoSandboxFn(repo, { ref: getRepoDefaultBranch(repo) }).catch((err) => {
        const wrapped = taggedError(`Could not check out the platform repository: ${err.message}`, 'repo_checkout');
        wrapped.code = err.code || null;
        throw wrapped;
      });

      // Tests need real devDependencies installed — unlike the read-only
      // analysis worker's `npm ci --omit=dev`, and unlike
      // design_task.py's own _validate_code_self_repair (which never ran
      // an install step at all, relying on whatever the OpenHands sandbox
      // image happened to have pre-baked). Done once, before the loop, not
      // inside validate() — installing is expensive and the dependency
      // tree doesn't change between fix-retry rounds.
      const install = await runSandboxCommand(sandbox, 'npm', ['ci'], { allowlist: ['npm'], timeoutMs: 600_000 });
      if (!install.ok) {
        throw taggedError(`npm ci failed in the checked-out platform repo: ${install.output}`, 'agent_run');
      }

      const codeFiles = await listSandboxFiles(sandbox, 'server');
      const before = await snapshotFiles(sandbox, codeFiles);
      const result = await runAgentLoop({
        systemPrompt: CODE_SELF_REPAIR_SYSTEM,
        taskPrompt: buildCodeSelfRepairPrompt({ generatorId, reason, errorMessage, occurrenceDays, testFileHint }),
        sandbox,
        allowlist: ['node'],
        fileAllowlist: null, // open scope within server/ — enforced by validateCodeSelfRepair, not a fixed 2-file list
        validate: () => validateCodeSelfRepair(sandbox, { testFileHint }, before),
      });

      if (result.status !== 'ok') {
        throw taggedError(result.detail || 'code-self-repair agent did not produce a validated result.', 'result_validation');
      }
      return {
        jobId: job.id, detail: result.summary || null, rootCause: result.rootCause || null, summary: result.summary || null,
        testsPassed: result.testsPassed === true, testOutput: result.testOutput || null,
        patch: result.patch || null, filesChanged: result.filesChanged || [],
      };
    } finally {
      await destroySandbox(sandbox);
    }
  };
}
