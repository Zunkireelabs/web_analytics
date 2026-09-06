import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutRepoTarball } from './repo-checkout.js';

const execFileAsync = promisify(execFile);

// getRepoTarball (github/client.js) does a real authenticated GitHub HTTP
// call — stubbed here via getRepoTarballFn (same injectable-function
// convention as design-drift.js's fetchPage/fetchStylesheet) so this test
// never touches the network or needs a real GITHUB_PAT. The stub returns
// bytes from a REAL tarball built with the system `tar` binary, nested
// under one top-level directory exactly the way GitHub's tarball endpoint
// nests everything under `<owner>-<repo>-<sha>/` — so --strip-components=1
// is exercised for real, not assumed.
async function buildFakeRepoTarball() {
  const stageDir = await mkdtemp(join(tmpdir(), 'repo-checkout-test-stage-'));
  const nestedDir = join(stageDir, 'acme-site-abc123');
  await mkdir(join(nestedDir, 'css'), { recursive: true });
  await writeFile(join(nestedDir, 'index.html'), '<html>fake repo root</html>');
  await writeFile(join(nestedDir, 'css', 'styles.css'), '.card { color: red; }');

  const tarPath = join(stageDir, 'out.tar.gz');
  await execFileAsync('tar', ['-czf', tarPath, '-C', stageDir, 'acme-site-abc123']);
  const bytes = await readFile(tarPath);
  await rm(stageDir, { recursive: true, force: true });
  return bytes;
}

describe('checkoutRepoTarball', () => {
  test('extracts a real tarball into destDir with the top-level dir stripped', async () => {
    const tarballBytes = await buildFakeRepoTarball();
    const destDir = await mkdtemp(join(tmpdir(), 'repo-checkout-test-dest-'));
    try {
      const site = { repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main' };
      const getRepoTarballFn = async (calledSite, ref) => {
        assert.equal(calledSite, site);
        assert.equal(ref, 'main');
        return tarballBytes;
      };

      await checkoutRepoTarball(site, destDir, { getRepoTarballFn });

      const indexHtml = await readFile(join(destDir, 'index.html'), 'utf8');
      assert.equal(indexHtml, '<html>fake repo root</html>');
      const css = await readFile(join(destDir, 'css', 'styles.css'), 'utf8');
      assert.match(css, /\.card/);

      // The top-level nested dir itself must NOT appear inside destDir —
      // proof --strip-components=1 actually ran.
      const entries = await readdir(destDir);
      assert.ok(!entries.includes('acme-site-abc123'));

      // The intermediate .tar.gz must be cleaned up, not left sitting in
      // the workspace that gets bind-mounted into the Docker container.
      assert.ok(!entries.includes('.repo-checkout.tar.gz'));
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('throws a clear error when the site has no repo configured', async () => {
    const destDir = await mkdtemp(join(tmpdir(), 'repo-checkout-test-dest-'));
    try {
      await assert.rejects(
        checkoutRepoTarball({ repo_owner: null, repo_name: null }, destDir, { getRepoTarballFn: async () => Buffer.from('') }),
        /has no repo_owner\/repo_name configured/
      );
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test('uses the explicit ref when given, instead of the default branch', async () => {
    const tarballBytes = await buildFakeRepoTarball();
    const destDir = await mkdtemp(join(tmpdir(), 'repo-checkout-test-dest-'));
    try {
      const site = { repo_owner: 'acme', repo_name: 'site', repo_default_branch: 'main' };
      let calledWithRef = null;
      const getRepoTarballFn = async (_site, ref) => { calledWithRef = ref; return tarballBytes; };

      await checkoutRepoTarball(site, destDir, { ref: 'feature/design-agent', getRepoTarballFn });
      assert.equal(calledWithRef, 'feature/design-agent');
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });
});
