import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComponentTemplateHandler, createDesignAgentHandler } from './openhands-handler.js';

// Stubs the entire Python+Docker+GitHub boundary (see test-support/
// fake-design-task-component-templates.js, and the injectable
// getSiteByIdFn/checkoutRepoTarballFn) — no real DB, GitHub API, Python
// interpreter, or Docker daemon touched anywhere in this file.
const here = path.dirname(fileURLToPath(import.meta.url));
const testSupportDir = path.join(here, 'test-support');
const fakeDockerBin = path.join(testSupportDir, 'fake-docker.js');

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
    });
    const result = await handler({ id: 1, site_id: 1 });
    assert.deepEqual(result.componentTemplates, {});
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
