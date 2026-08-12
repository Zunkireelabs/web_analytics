import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComponentTemplateHandler, createDesignAgentHandler } from './openhands-handler.js';

// Stubs the entire Python+Docker+GitHub+memory-lookup boundary (see
// test-support/fake-design-task-component-templates.js, and the injectable
// getSiteByIdFn/checkoutRepoTarballFn/findRelevantMemoryFn) — no real DB,
// GitHub API, Python interpreter, or Docker daemon touched anywhere in this
// file.
const here = path.dirname(fileURLToPath(import.meta.url));
const testSupportDir = path.join(here, 'test-support');
const fakeDockerBin = path.join(testSupportDir, 'fake-docker.js');
const noLessons = async () => [];

function tempLogPath(label) {
  return path.join(os.tmpdir(), `design-agent-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
}

describe('createComponentTemplateHandler', () => {
  test('looks up the job\'s site, checks out its real repo, and returns the derived componentTemplates', async () => {
    const site = { id: 7, repo_owner: 'acme', repo_name: 'site' };
    let getSiteByIdCalledWith = null;
    let checkoutCalledWith = null;

    const handler = createComponentTemplateHandler({
      pythonBin: process.execPath,
      scriptPath: path.join(testSupportDir, 'fake-design-task-component-templates.js'),
      dockerBin: fakeDockerBin,
      getSiteByIdFn: async (siteId) => { getSiteByIdCalledWith = siteId; return site; },
      checkoutRepoTarballFn: async (calledSite, destDir) => { checkoutCalledWith = { site: calledSite, destDir }; },
      findRelevantMemoryFn: noLessons,
    });

    const job = { id: 99, site_id: 7, params: { componentKeys: ['faq', 'expand-content'] } };
    const result = await handler(job);

    assert.equal(getSiteByIdCalledWith, 7);
    assert.equal(checkoutCalledWith.site, site);
    assert.ok(checkoutCalledWith.destDir, 'checkoutRepoTarballFn should receive the handler\'s own temp workspace dir');

    assert.equal(result.jobId, 99);
    assert.deepEqual(Object.keys(result.componentTemplates).sort(), ['expand-content', 'faq']);
    assert.match(result.componentTemplates.faq.row, /faq/);
  });

  test('defaults componentKeys to an empty list when the job has no params', async () => {
    const handler = createComponentTemplateHandler({
      pythonBin: process.execPath,
      scriptPath: path.join(testSupportDir, 'fake-design-task-component-templates.js'),
      dockerBin: fakeDockerBin,
      getSiteByIdFn: async () => ({ id: 1, repo_owner: 'acme', repo_name: 'site' }),
      checkoutRepoTarballFn: async () => {},
      findRelevantMemoryFn: noLessons,
    });
    const result = await handler({ id: 1, site_id: 1 });
    assert.deepEqual(result.componentTemplates, {});
  });

  test('looks up agent_fix_memory scoped to the job\'s site and the design-agent generatorId, and passes it through to the task', async () => {
    let memoryLookupArgs = null;
    const lessons = [
      { symptoms: 'Derived a template using a class that only exists in the fixture, not the real repo.', rootCause: 'Skimmed the repo instead of grepping for the class.', executionPermission: 'informational', fixPattern: null },
    ];
    const lessonsLog = tempLogPath('lessons');
    try {
      const handler = createComponentTemplateHandler({
        pythonBin: process.execPath,
        scriptPath: path.join(testSupportDir, 'fake-design-task-component-templates.js'),
        dockerBin: fakeDockerBin,
        getSiteByIdFn: async () => ({ id: 12, repo_owner: 'acme', repo_name: 'site' }),
        checkoutRepoTarballFn: async () => {},
        findRelevantMemoryFn: async (args) => { memoryLookupArgs = args; return lessons; },
      });
      process.env.DESIGN_AGENT_TEST_LESSONS_LOG = lessonsLog;
      await handler({ id: 2, site_id: 12, params: { componentKeys: ['faq'] } });

      assert.equal(memoryLookupArgs.siteId, 12);
      assert.equal(memoryLookupArgs.generatorId, 'design-agent-component-templates');
      assert.equal(memoryLookupArgs.clientFacing, true);

      const loggedLessons = JSON.parse(fs.readFileSync(lessonsLog, 'utf8'));
      assert.equal(loggedLessons.length, 1);
      assert.equal(loggedLessons[0].symptoms, lessons[0].symptoms);
      assert.equal(loggedLessons[0].fixPattern, null, 'an informational (non-auto) row must never surface its fixPattern as reusable content');
    } finally {
      delete process.env.DESIGN_AGENT_TEST_LESSONS_LOG;
      fs.rmSync(lessonsLog, { force: true });
    }
  });

  test('never lets a memory-lookup failure block the job', async () => {
    const handler = createComponentTemplateHandler({
      pythonBin: process.execPath,
      scriptPath: path.join(testSupportDir, 'fake-design-task-component-templates.js'),
      dockerBin: fakeDockerBin,
      getSiteByIdFn: async () => ({ id: 4, repo_owner: 'acme', repo_name: 'site' }),
      checkoutRepoTarballFn: async () => {},
      findRelevantMemoryFn: async () => { throw new Error('DB is down'); },
    });
    const result = await handler({ id: 3, site_id: 4, params: { componentKeys: ['faq'] } });
    assert.ok(result.componentTemplates.faq);
  });
});

describe('createDesignAgentHandler — dispatch by job.params.mode', () => {
  test('routes a component-templates job to the real-repo-checkout path, never touching the fixture', async () => {
    let checkoutCalled = false;
    const handler = createDesignAgentHandler({
      pythonBin: process.execPath,
      scriptPath: path.join(testSupportDir, 'fake-design-task-component-templates.js'), // used for BOTH modes here on purpose — see next test for why that's safe
      dockerBin: fakeDockerBin,
      getSiteByIdFn: async () => ({ id: 3, repo_owner: 'acme', repo_name: 'site' }),
      checkoutRepoTarballFn: async () => { checkoutCalled = true; },
      findRelevantMemoryFn: noLessons,
    });
    const job = { id: 5, site_id: 3, params: { mode: 'component-templates', componentKeys: ['faq'] } };
    const result = await handler(job);
    assert.equal(checkoutCalled, true);
    assert.ok(result.componentTemplates.faq);
  });

  test('routes a job with no params.mode to the fixture-demo path, never checking out a repo', async () => {
    let checkoutCalled = false;
    const handler = createDesignAgentHandler({
      pythonBin: process.execPath,
      scriptPath: path.join(testSupportDir, 'fake-design-task-ok.js'), // the plain 6D-era stub — no componentTemplates in its result
      dockerBin: fakeDockerBin,
      getSiteByIdFn: async () => { throw new Error('should never be called for the fixture-demo path'); },
      checkoutRepoTarballFn: async () => { checkoutCalled = true; },
    });
    const result = await handler({ id: 6, site_id: 3 }); // no params at all
    assert.equal(checkoutCalled, false);
    assert.equal(result.detail, 'stub: task completed');
  });
});
