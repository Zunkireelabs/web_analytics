import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import {
  getBranchSha, createBranch, commitFilesAtomic, openPullRequest,
  listOpenPullRequestsForBranch, defaultBranchName,
} from '../github/client.js';

// Installs Phase 2 of the Rendering Validation Gate (see
// implementers/lib/rendering-gate.js's module comment) into a CLIENT repo —
// a GitHub Actions workflow that builds the real site and checks the real
// rendered HTML output, running in GitHub's own sandboxed runner, never on
// this app's infrastructure (see action-center-onboarding SKILL.md §1b for
// the "why here, not in-app" decision). Opens a real PR; a human reviews
// and merges it on GitHub, same "never auto-merge" rule as every draft this
// app produces (implementers/lib/github-ops.js's openPrForBranch).
//
// Run once per site, after `npm run connect-repo` has already set
// repo_owner/repo_name and (ideally) url_file_map.renderCapabilities.build:
//
//   node server/scripts/install-rendering-workflow.js --site-id <id> \
//     [--install-command "npm ci"] [--build-command "npm run build"] \
//     [--output-dir "_site"]
//
// CLI flags override url_file_map.renderCapabilities.build for THIS
// install's rendered workflow file; they do not write back to the DB —
// re-run `connect-repo` with an updated --url-file-map if you want the
// stored config itself to change.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '../implementers/lib/rendering-validation-templates');
const BRANCH_NAME_SUFFIX = 'rendering-validation-workflow';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

function renderWorkflow({ defaultBranch, installCommand, buildCommand, outputDir }) {
  const template = readFileSync(join(TEMPLATE_DIR, 'workflow.yml'), 'utf8');
  return template
    .replaceAll('__DEFAULT_BRANCH__', defaultBranch)
    .replaceAll('__INSTALL_COMMAND__', installCommand)
    .replaceAll('__BUILD_COMMAND__', buildCommand)
    .replaceAll('__OUTPUT_DIR__', outputDir);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) {
    throw new Error('Usage: install-rendering-workflow.js --site-id <id> [--install-command "npm ci"] [--build-command "npm run build"] [--output-dir "_site"]');
  }

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site found with id ${siteId}.`);
  if (!site.repo_owner || !site.repo_name) {
    throw new Error(`Site #${siteId} has no repo_owner/repo_name — run \`npm run connect-repo\` first.`);
  }

  const build = site.url_file_map?.renderCapabilities?.build || {};
  const installCommand = flags['install-command'] || build.installCommand;
  const buildCommand = flags['build-command'] || build.buildCommand;
  const outputDir = flags['output-dir'] || build.outputDir;
  if (!installCommand || !buildCommand || !outputDir) {
    throw new Error(
      'Missing install/build command or output dir — pass --install-command/--build-command/--output-dir, '
      + 'or record them once at url_file_map.renderCapabilities.build via `npm run connect-repo` (see types.js).'
    );
  }

  const branchName = `action-center/${BRANCH_NAME_SUFFIX}`;
  const baseBranch = defaultBranchName(site);
  const baseSha = await getBranchSha(site, baseBranch);
  await createBranch(site, branchName, baseSha);

  const workflowContent = renderWorkflow({ defaultBranch: baseBranch, installCommand, buildCommand, outputDir });
  const cleanOutputScript = readFileSync(join(TEMPLATE_DIR, 'check-rendered-output.mjs'), 'utf8');
  const siblingsScript = readFileSync(join(TEMPLATE_DIR, 'check-family-siblings.mjs'), 'utf8');

  try {
    await commitFilesAtomic(site, branchName, [
      { path: '.github/workflows/rendering-validation.yml', content: workflowContent },
      { path: 'scripts/check-rendered-output.mjs', content: cleanOutputScript },
      { path: 'scripts/check-family-siblings.mjs', content: siblingsScript },
    ], 'Action Center: install the Rendering Validation Gate (clean-build + sibling non-leakage checks)');
  } catch (err) {
    // Writing under .github/workflows/ is a DIFFERENT, narrower GitHub
    // permission than writing anywhere else in the repo — a fine-grained PAT
    // needs its "Workflows" permission explicitly granted (Read and write),
    // and a classic PAT needs the `workflow` OAuth scope, neither of which
    // "Contents: Read and write" implies. Confirmed empirically installing
    // this on zunkireelabs-web: committing the two plain .mjs scripts alone
    // succeeded with the exact same token; only adding the workflow.yml path
    // under .github/workflows/ produced this 403, with GitHub's own generic
    // "Resource not accessible by personal access token" message giving no
    // hint that a SPECIFIC permission (not general repo write access) is
    // what's missing. Diagnosed here once so the next person doesn't have to
    // re-derive it from GitHub's docs.
    if (/403/.test(err.message) && /create tree/.test(err.message)) {
      throw new Error(
        `${err.message}\n\nThis specific 403 almost always means the token can write to the repo in general but `
        + 'lacks GitHub\'s separate "Workflows" permission, which is required to create or modify anything under '
        + '.github/workflows/ — a fine-grained PAT needs "Workflows: Read and write" added under its repository '
        + 'permissions (github.com/settings/personal-access-tokens), a classic PAT needs the `workflow` scope. '
        + 'Update the token, then re-run this script — createBranch/commitFilesAtomic are idempotent, so it is '
        + 'safe to retry.'
      );
    }
    throw err;
  }

  const existing = await listOpenPullRequestsForBranch(site, branchName);
  if (existing.length > 0) {
    console.log(`Existing PR updated with the latest workflow: ${existing[0].html_url}`);
    return;
  }

  const { url } = await openPullRequest(site, {
    branch: branchName,
    title: 'Action Center: install Rendering Validation Gate workflow',
    body: 'Adds `.github/workflows/rendering-validation.yml`, `scripts/check-rendered-output.mjs` and '
      + '`scripts/check-family-siblings.mjs`.\n\n'
      + 'On every PR, this builds the site and runs two checks against the real rendered HTML output — the '
      + 'client-repo-build half of the Action Center\'s Rendering Validation Gate:\n\n'
      + '1. **Clean build** — fails if the output still contains raw Markdown syntax or unresolved template tags.\n'
      + '2. **Sibling non-leakage** — for any shared, data-driven template family (e.g. this site\'s '
      + '`/glossary/*`, `/compare/*`, `/locations/*`), builds the PR twice (merge base and head) and fails if '
      + 'more than one page in a family changed, unless a commit in the PR contains `[family-write]` to declare '
      + 'that intentional. Proves a page-specific fix did not leak into every page sharing that template.\n\n'
      + 'Review the diff and merge into the default branch to enable it. Afterward, consider making '
      + '"rendering-validation" a required status check in this repo\'s branch protection settings so a '
      + 'red check actually blocks merging (GitHub Settings → Branches — this PAT does not have '
      + 'permission to set that automatically).',
  });
  console.log(`Opened PR: ${url}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('install-rendering-workflow failed:', err.message);
    await pool.end();
    process.exit(1);
  });
