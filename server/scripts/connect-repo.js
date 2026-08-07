import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pool, updateSiteRepoConfig } from '../db.js';
import { getSiteById } from '../store/read.js';
import { auditSite } from './audit-url-file-map.js';

// Attach a GitHub repo to a site already created via `npm run create-client`,
// so the Action Center can apply approved drafts as real pull requests
// (server/implementers/, server/github/client.js). Mirrors connect-site.js's
// one-time-setup shape — run once per site, not re-given per draft.
//
//   node server/scripts/connect-repo.js --site-id <id> \
//     --repo-owner "zunkiree-labs" --repo-name "zunkireelabs-site" \
//     [--repo-url "https://github.com/zunkiree-labs/zunkireelabs-site"] \
//     [--default-branch main] [--tech-stack astro] \
//     [--github-pat-env-var GITHUB_PAT] \
//     [--url-file-map path/to/url-file-map.json]
//
// url-file-map.json shape (see server/implementers/types.js / migration 028):
//   { "pages": {...}, "patterns": [...], "newContentTargets": {...}, "siteRoot": {...},
//     "renderCapabilities": {...} }
//
// renderCapabilities is REQUIRED before any newContentTargets entry (net-new
// pages: landing-page, blog-outline, direct-answer, translation, legal/
// compliance pages) can actually apply — see types.js's "Render capability"
// doc block. It records, per file extension (and optionally per action
// type), whether this repo's own static-site generator actually runs a
// Markdown pass on that target — e.g.:
//   "renderCapabilities": {
//     "generator": "eleventy",
//     "extensions": { ".md": {"markdown": true}, ".njk": {"markdown": false} },
//     "overrides": { "landing-page": {"markdown": true} }
//   }
// `npm run audit-url-file-map` (auto-run below) reports any newContentTargets
// entry missing a matching renderCapabilities entry as a config gap.

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = Number(flags['site-id']);
  if (!siteId) {
    throw new Error(
      'Usage: connect-repo.js --site-id <id> --repo-owner <org> --repo-name <repo> [--repo-url <url>] [--default-branch main] [--tech-stack astro] [--github-pat-env-var GITHUB_PAT] [--url-file-map path.json]'
    );
  }

  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site found with id ${siteId}.`);

  const update = {};
  if (flags['repo-owner'] != null) update.repoOwner = flags['repo-owner'];
  if (flags['repo-name'] != null) update.repoName = flags['repo-name'];
  if (flags['repo-url'] != null) update.repoUrl = flags['repo-url'];
  if (flags['default-branch'] != null) update.repoDefaultBranch = flags['default-branch'];
  if (flags['tech-stack'] != null) update.techStack = flags['tech-stack'];
  if (flags['github-pat-env-var'] != null) update.githubPatEnvVar = flags['github-pat-env-var'];
  if (flags['url-file-map'] != null) update.urlFileMap = JSON.parse(readFileSync(flags['url-file-map'], 'utf8'));

  if (!Object.keys(update).length) {
    throw new Error('Pass at least one of --repo-owner, --repo-name, --repo-url, --default-branch, --tech-stack, --github-pat-env-var, --url-file-map.');
  }

  const updated = await updateSiteRepoConfig({ siteId, ...update });
  console.log(`Updated site #${updated.id} "${updated.name}":`);
  if (update.repoOwner !== undefined) console.log(`  repo_owner → ${updated.repo_owner}`);
  if (update.repoName !== undefined) console.log(`  repo_name → ${updated.repo_name}`);
  if (update.repoUrl !== undefined) console.log(`  repo_url → ${updated.repo_url}`);
  if (update.repoDefaultBranch !== undefined) console.log(`  repo_default_branch → ${updated.repo_default_branch}`);
  if (update.techStack !== undefined) console.log(`  tech_stack → ${updated.tech_stack}`);
  if (update.githubPatEnvVar !== undefined) console.log(`  github_pat_env_var → ${updated.github_pat_env_var}`);
  if (update.urlFileMap !== undefined) console.log('  url_file_map → updated');

  if (updated.repo_owner && updated.repo_name) {
    console.log(`Repo configured: ${updated.repo_owner}/${updated.repo_name}. Make sure the ${updated.github_pat_env_var} env var is set, then check Integration Health for "GitHub (Action Center)".`);

    // Auto-run the same config-completeness check `npm run audit-url-file-map`
    // does, right now, instead of leaving it as a separate step someone has
    // to remember — this is exactly the gap that let drafts get stuck on
    // missing url_file_map entries / vanished SEOAI markers after onboarding
    // looked "done." Best-effort: a failure here (e.g. GitHub API hiccup)
    // must not undo the repo config write above.
    console.log('\nRunning config-completeness check...');
    try {
      await auditSite(siteId);
    } catch (err) {
      console.warn(`Config check failed to run: ${err.message} — run \`npm run audit-url-file-map -- --site-id ${siteId}\` manually before relying on this site's drafts.`);
    }
  } else {
    console.log('Still missing repo_owner/repo_name — Apply Change will 400 until both are set.');
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('connect-repo failed:', err.message);
    await pool.end();
    process.exit(1);
  });
