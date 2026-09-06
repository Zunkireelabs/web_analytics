import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pool, updateSiteRepoConfig, updateSiteAutoRemediation } from '../db.js';
import { getSiteById } from '../store/read.js';
import { auditSite } from './audit-url-file-map.js';
import { shouldAutoEnableOnConnect } from '../routes/clients.js';
import { queueDesignAgentDerivationForSite } from '../job.js';
import { refreshBlockedRecommendations } from '../agents/lib/recommendation-coordinator.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

// A synthetic req so recordAuditEvent's resolveActor(req) records this as a
// 'system' actor rather than throwing on a missing req.userId — same shape
// design-drift.js's own systemActorReq uses for the same reason.
function systemActorReq(siteId) {
  return { userId: null, siteId, ip: null, get: () => null };
}

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
      'Usage: connect-repo.js --site-id <id> --repo-owner <org> --repo-name <repo> [--repo-url <url>] [--default-branch main] [--tech-stack astro] [--github-pat-env-var GITHUB_PAT] [--github-app-installation-id <id>|none] [--url-file-map path.json]'
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
  // The tenant installs the GitHub App on their own repo and GitHub assigns an
  // installation id; passing it here switches this site off PAT auth entirely
  // (see server/github/credentials.js). 'none' moves it back to its PAT.
  if (flags['github-app-installation-id'] != null) {
    update.githubAppInstallationId = flags['github-app-installation-id'] === 'none'
      ? null
      : Number(flags['github-app-installation-id']);
    if (update.githubAppInstallationId !== null && !Number.isInteger(update.githubAppInstallationId)) {
      throw new Error('--github-app-installation-id must be an integer (or "none" to clear it).');
    }
  }
  if (flags['url-file-map'] != null) update.urlFileMap = JSON.parse(readFileSync(flags['url-file-map'], 'utf8'));

  if (!Object.keys(update).length) {
    throw new Error('Pass at least one of --repo-owner, --repo-name, --repo-url, --default-branch, --tech-stack, --github-pat-env-var, --github-app-installation-id, --url-file-map.');
  }

  let updated = await updateSiteRepoConfig({ siteId, ...update });
  console.log(`Updated site #${updated.id} "${updated.name}":`);
  if (update.repoOwner !== undefined) console.log(`  repo_owner → ${updated.repo_owner}`);
  if (update.repoName !== undefined) console.log(`  repo_name → ${updated.repo_name}`);
  if (update.repoUrl !== undefined) console.log(`  repo_url → ${updated.repo_url}`);
  if (update.repoDefaultBranch !== undefined) console.log(`  repo_default_branch → ${updated.repo_default_branch}`);
  if (update.techStack !== undefined) console.log(`  tech_stack → ${updated.tech_stack}`);
  if (update.githubPatEnvVar !== undefined) console.log(`  github_pat_env_var → ${updated.github_pat_env_var}`);
  if (update.githubAppInstallationId !== undefined) console.log(`  github_app_installation_id → ${updated.github_app_installation_id ?? '(none — uses PAT)'}`);
  if (update.urlFileMap !== undefined) console.log('  url_file_map → updated');

  if (updated.repo_owner && updated.repo_name) {
    console.log(`Repo configured: ${updated.repo_owner}/${updated.repo_name}. Make sure the ${updated.github_pat_env_var} env var is set, then check Integration Health for "GitHub (Action Center)".`);

    // Full onboarding autonomy — same rule and same shouldAutoEnableOnConnect
    // function routes/clients.js's HTTP /connect-repo route uses, so a site
    // connected via this CLI script (the path staff actually use for
    // onboarding, per the action-center-onboarding runbook) enters the
    // self-healing/auto-remediation pipeline exactly the same way a site
    // connected through the admin UI would — no separate manual click either
    // way. Scoped to a genuinely first connection only; see that function's
    // own comment for why re-running this script against an already-connected
    // site must never re-flip a human's later decision to turn it off.
    if (shouldAutoEnableOnConnect({ existing: site, site: updated })) {
      updated = await updateSiteAutoRemediation({ siteId, enabled: true, dailyLimit: updated.auto_remediation_daily_limit });
      console.log(`  auto_remediation_enabled → true (daily limit ${updated.auto_remediation_daily_limit}) — full onboarding autonomy granted on this first repo connection.`);
      await recordAuditEvent(systemActorReq(siteId), {
        action: 'tenant.auto_remediation_enabled',
        targetType: 'site',
        targetId: String(siteId),
        tenantSiteId: siteId,
        tenantName: updated.name,
        metadata: { enabled: true, dailyLimit: updated.auto_remediation_daily_limit, autoEnabledAtOnboarding: true, via: 'connect-repo.js' },
        success: true,
      }).catch((err) => console.warn(`Could not record audit event: ${err.message}`));
    }

    // Best-effort, same as the HTTP route: queue the whole-site Design Agent
    // derivation right away rather than waiting for the next 06:00 sweep.
    queueDesignAgentDerivationForSite(updated).catch((err) =>
      console.warn(`Could not queue Design Agent derivation: ${err.message} — the next daily sweep will pick this up instead.`)
    );

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

    // Re-evaluate any recommendation this site already had sitting blocked
    // BEFORE this connect/reconfigure — the repo/url_file_map write above is
    // exactly the kind of fix refreshBlockedRecommendations exists to detect,
    // and without this it would otherwise sit stale until the next daily
    // (07:00 local) / weekly cron tick. Both passes (see job.js's own split)
    // so a resolved gap of either kind clears immediately rather than
    // waiting on its own cadence. Best-effort, same reasoning as the audit
    // above: a failure here must not undo the repo config write.
    console.log('Re-checking previously blocked recommendations against the updated config...');
    try {
      const [daily, weekly] = await Promise.all([
        refreshBlockedRecommendations(siteId, { excludeDetectingAgent: 'analyst-keyword-gaps' }),
        refreshBlockedRecommendations(siteId, { onlyDetectingAgent: 'analyst-keyword-gaps' }),
      ]);
      const updated = (daily.updated || 0) + (weekly.updated || 0);
      const checked = (daily.checked || 0) + (weekly.checked || 0);
      console.log(`Reconciled ${checked} blocked recommendation(s), ${updated} unblocked/updated.`);
    } catch (err) {
      console.warn(`Reconciliation failed to run: ${err.message} — the daily/weekly cron will pick this up instead.`);
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
