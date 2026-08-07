import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionOf, validateRendering, validateRenderingBatch, checkClientBuildStatus, CLIENT_BUILD_CHECK_NAME } from './rendering-gate.js';

function siteWithCaps(renderCapabilities) {
  return { id: 1, name: 'Test Site', url_file_map: { renderCapabilities } };
}

test('extensionOf prefers a compound suffix over the last dot alone', () => {
  assert.equal(extensionOf('src/pages/about.11ty.md'), '.11ty.md');
  assert.equal(extensionOf('src/pages/about.md'), '.md');
  assert.equal(extensionOf('src/pages/about.njk'), '.njk');
  assert.equal(extensionOf('no-extension'), '');
});

test('non-markdown files (no contentFormat) always pass, regardless of config', async () => {
  const site = { id: 1, name: 'No Config Site' }; // no url_file_map at all
  const result = await validateRendering(site, { path: 'src/data/locations.js', content: 'module.exports = []' });
  assert.equal(result.ok, true);
});

test('markdown file on a recorded markdown-safe extension passes', async () => {
  const site = siteWithCaps({ extensions: { '.md': { markdown: true } } });
  const result = await validateRendering(site, { path: 'src/blog/post.md', content: '# Title', contentFormat: 'markdown' });
  assert.equal(result.ok, true);
});

test('markdown file on a recorded compound extension (.11ty.md) passes', async () => {
  const site = siteWithCaps({ extensions: { '.11ty.md': { markdown: true } } });
  const result = await validateRendering(site, { path: 'src/blog/post.11ty.md', content: '# Title', contentFormat: 'markdown' });
  assert.equal(result.ok, true);
});

test('markdown file on a recorded unsafe extension fails closed', async () => {
  const site = siteWithCaps({ extensions: { '.njk': { markdown: false } } });
  const result = await validateRendering(site, { path: 'src/pages/about.njk', content: '# Title', contentFormat: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'render-unsafe-target');
  assert.match(result.error, /NOT Markdown-safe/);
});

test('markdown file with no renderCapabilities recorded at all fails closed', async () => {
  const site = { id: 2, name: 'Unconfigured Site', url_file_map: {} };
  const result = await validateRendering(site, { path: 'src/pages/about.md', content: '# Title', contentFormat: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'render-capabilities-not-configured');
  assert.match(result.error, /connect-repo/);
});

test('markdown file whose extension has no recorded entry fails closed (unknown treated as unsafe)', async () => {
  const site = siteWithCaps({ extensions: { '.md': { markdown: true } } }); // .astro not recorded
  const result = await validateRendering(site, { path: 'src/pages/about.astro', content: '# Title', contentFormat: 'markdown' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'render-capability-unknown');
});

test('per-actionType override wins over an unsafe extension entry', async () => {
  const site = siteWithCaps({
    extensions: { '.njk': { markdown: false } },
    overrides: { 'landing-page': { markdown: true } },
  });
  const result = await validateRendering(site, {
    path: 'src/pages/about.njk', content: '# Title', contentFormat: 'markdown', actionType: 'landing-page',
  });
  assert.equal(result.ok, true);
});

test('per-actionType override can also fail closed (override explicitly marks it unsafe)', async () => {
  const site = siteWithCaps({
    extensions: { '.md': { markdown: true } },
    overrides: { 'weird-type': { markdown: false } },
  });
  const result = await validateRendering(site, {
    path: 'src/pages/about.md', content: '# Title', contentFormat: 'markdown', actionType: 'weird-type',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'render-unsafe-target');
});

test('validateRenderingBatch short-circuits on the first unsafe file, in order', async () => {
  const site = siteWithCaps({ extensions: { '.md': { markdown: true }, '.njk': { markdown: false } } });
  const files = [
    { path: 'src/pages/safe.md', content: '# ok', contentFormat: 'markdown' },
    { path: 'src/pages/unsafe.njk', content: '# bad', contentFormat: 'markdown' },
    { path: 'src/pages/never-checked.astro', content: '# unreachable', contentFormat: 'markdown' },
  ];
  const result = await validateRenderingBatch(site, files);
  assert.equal(result.ok, false);
  assert.match(result.error, /unsafe\.njk/);
});

test('validateRenderingBatch passes a mixed batch when every markdown file is safe and non-markdown files are ignored', async () => {
  const site = siteWithCaps({ extensions: { '.md': { markdown: true } } });
  const files = [
    { path: 'src/blog/post.md', content: '# ok', contentFormat: 'markdown' },
    { path: 'src/data/locations.js', content: 'module.exports = []' }, // no contentFormat — untouched
  ];
  const result = await validateRenderingBatch(site, files);
  assert.equal(result.ok, true);
});

// --- Phase 2: checkClientBuildStatus (the client-repo-build half) ---

test('checkClientBuildStatus: no matching check run yet — not-configured', async () => {
  const site = { id: 1, name: 'Test Site' };
  const fakeGetCheckRuns = async () => [{ name: 'some-other-check', status: 'completed', conclusion: 'success' }];
  const result = await checkClientBuildStatus(site, 'action-center/batch-1-2026-08-07', fakeGetCheckRuns);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'client-build-check-not-configured');
  assert.match(result.error, /install-rendering-workflow/);
});

test('checkClientBuildStatus: check run still running — pending', async () => {
  const site = { id: 1, name: 'Test Site' };
  const fakeGetCheckRuns = async () => [{ name: CLIENT_BUILD_CHECK_NAME, status: 'in_progress', conclusion: null }];
  const result = await checkClientBuildStatus(site, 'ref', fakeGetCheckRuns);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'client-build-check-pending');
});

test('checkClientBuildStatus: check completed but failed', async () => {
  const site = { id: 1, name: 'Test Site' };
  const fakeGetCheckRuns = async () => [{ name: CLIENT_BUILD_CHECK_NAME, status: 'completed', conclusion: 'failure' }];
  const result = await checkClientBuildStatus(site, 'ref', fakeGetCheckRuns);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'client-build-check-failed');
  assert.match(result.error, /Checks tab/);
});

test('checkClientBuildStatus: check completed and passed', async () => {
  const site = { id: 1, name: 'Test Site' };
  const fakeGetCheckRuns = async () => [{ name: CLIENT_BUILD_CHECK_NAME, status: 'completed', conclusion: 'success' }];
  const result = await checkClientBuildStatus(site, 'ref', fakeGetCheckRuns);
  assert.equal(result.ok, true);
});

test('checkClientBuildStatus: a GitHub API error is reported honestly, not swallowed', async () => {
  const site = { id: 1, name: 'Test Site' };
  const fakeGetCheckRuns = async () => { throw new Error('getCheckRunsForRef failed (404): Not Found'); };
  const result = await checkClientBuildStatus(site, 'ref', fakeGetCheckRuns);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'client-build-check-unavailable');
  assert.match(result.error, /Not Found/);
});
