import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getRepoTarball, defaultBranchName } from '../github/client.js';

const execFileAsync = promisify(execFile);

// Downloads a real tenant repo's tarball (getRepoTarball, github/client.js —
// still REST-only, no git clone, no PAT-in-URL) and extracts it into
// `destDir`, which the caller must already have created (e.g. via mkdtemp)
// and must be empty. GitHub's tarball nests everything under one top-level
// `<owner>-<repo>-<sha>/` directory, hence --strip-components=1 so destDir's
// contents match the repo root directly — the same shape
// openhands-handler.js's fixture-copy path already produces, so this is a
// drop-in replacement for that copy step, not a new workspace shape.
export async function checkoutRepoTarball(site, destDir, { ref, getRepoTarballFn = getRepoTarball } = {}) {
  if (!site.repo_owner || !site.repo_name) {
    throw new Error('Site has no repo_owner/repo_name configured — cannot check out a real repo.');
  }
  const tarball = await getRepoTarballFn(site, ref || defaultBranchName(site));
  const tarPath = join(destDir, '.repo-checkout.tar.gz');
  try {
    await writeFile(tarPath, tarball);
    await execFileAsync('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1']);
  } finally {
    await rm(tarPath, { force: true });
  }
}
