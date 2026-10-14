import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, createClientSite } from '../db.js';
import { getUserByEmail, createUser } from '../store/users.js';
import { getSiteById } from '../store/read.js';
import { ensureAnalystClient, assessTenantReadiness, printReadiness } from '../lib/tenant-provisioning.js';
import { performSiteConnect } from './connect-site.js';
import { performRepoConnect } from './connect-repo.js';

// The single coherent onboarding flow: create the login, connect GSC/GA4,
// connect the repo, and print one final readiness statement — in one
// command, instead of the three previously disconnected scripts a human had
// to remember to run in the right order (create-client.js, then
// connect-site.js, then connect-repo.js, each silent about what the other two
// still owed the tenant).
//
// Every step below is optional except the login — a client can legitimately
// onboard with analytics only, repo only, or neither on day one — but every
// step that IS possible from what was passed runs automatically, and
// printReadiness at the end states exactly what is still missing and why,
// rather than leaving that to be discovered weeks later when nothing has
// shipped.
//
//   node server/scripts/onboard-client.js <email> <password> --company "Acme Corp" \
//     [--domain acme.com] [--timezone Asia/Kolkata] \
//     [--gsc-property "sc-domain:acme.com"] [--ga4-property-id 123456789] [--email-to contact@acme.com] \
//     [--repo-owner acme] [--repo-name acme-site] [--repo-url ...] [--default-branch main] \
//     [--tech-stack astro] [--github-pat-env-var GITHUB_PAT] [--github-app-installation-id <id>] \
//     [--url-file-map path.json]

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [email, password] = positional;

  if (!email || !password || !flags.company) {
    throw new Error(
      'Usage: onboard-client.js <email> <password> --company "Name" [--domain example.com] [--timezone Asia/Kolkata] ' +
      '[--gsc-property ...] [--ga4-property-id ...] [--email-to ...] ' +
      '[--repo-owner ...] [--repo-name ...] [--repo-url ...] [--default-branch main] [--tech-stack ...] [--github-pat-env-var ...] [--github-app-installation-id ...] [--url-file-map path.json]'
    );
  }
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await getUserByEmail(normalizedEmail);
  if (existing) throw new Error(`A user with email "${normalizedEmail}" already exists (id ${existing.id}, site ${existing.site_id}).`);

  const passwordHash = await bcrypt.hash(password, 10);

  console.log('Step 1/4 — creating the site and login...');
  const site = await createClientSite({ name: flags.company, websiteDomain: flags.domain, timezone: flags.timezone });
  const user = await createUser({ siteId: site.id, email: normalizedEmail, passwordHash });
  console.log(`  Created site #${site.id} "${site.name}" and user #${user.id} "${normalizedEmail}".`);

  const analyst = await ensureAnalystClient(site);
  console.log(analyst.ok
    ? `  Data Analyst client → registered (id ${site.id}).`
    : `  Data Analyst client → NOT registered: ${analyst.error || analyst.reason}.`);

  const hasAnalyticsFlags = ['gsc-property', 'ga4-property-id', 'email-to', 'logo'].some((k) => flags[k] != null);
  console.log('\nStep 2/4 — connecting GSC/GA4...');
  let currentSite = site;
  if (hasAnalyticsFlags) {
    const result = await performSiteConnect(currentSite, flags);
    currentSite = result.site;
  } else {
    console.log('  Skipped — no --gsc-property/--ga4-property-id passed. Run `npm run connect-site` later.');
  }

  const hasRepoFlags = ['repo-owner', 'repo-name', 'repo-url', 'default-branch', 'tech-stack', 'github-pat-env-var', 'github-app-installation-id', 'url-file-map']
    .some((k) => flags[k] != null);
  console.log('\nStep 3/4 — connecting the GitHub repo...');
  if (hasRepoFlags) {
    const result = await performRepoConnect(currentSite, flags);
    currentSite = result.site;
  } else {
    console.log('  Skipped — no --repo-owner/--repo-name passed. Run `npm run connect-repo` later.');
  }

  console.log('\nStep 4/4 — final readiness check...');
  const fresh = (await getSiteById(site.id)) || currentSite;
  printReadiness(await assessTenantReadiness(fresh));
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('onboard-client failed:', err.message);
    await pool.end();
    process.exit(1);
  });
