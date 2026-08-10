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
  const scriptContent = readFileSync(join(TEMPLATE_DIR, 'check-rendered-output.mjs'), 'utf8');

  await commitFilesAtomic(site, branchName, [
    { path: '.github/workflows/rendering-validation.yml', content: workflowContent },
    { path: 'scripts/check-rendered-output.mjs', content: scriptContent },
  ], 'Action Center: install Rendering Validation Gate (Phase 2 — real build check)');

  const existing = await listOpenPullRequestsForBranch(site, branchName);
  if (existing.length > 0) {
    console.log(`Existing PR updated with the latest workflow: ${existing[0].html_url}`);
    return;
  }

  const { url } = await openPullRequest(site, {
    branch: branchName,
    title: 'Action Center: install Rendering Validation Gate workflow',
    body: 'Adds `.github/workflows/rendering-validation.yml` and `scripts/check-rendered-output.mjs`.\n\n'
      + 'On every PR, this builds the site and fails the check if the real rendered HTML output still '
      + 'contains raw Markdown syntax or unresolved template tags — the client-repo-build half of the '
      + 'Action Center\'s two-layer Rendering Validation Gate.\n\n'
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
