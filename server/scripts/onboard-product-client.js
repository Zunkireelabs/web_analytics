import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, createClientSite } from '../db.js';
import { getUserByEmail, createUser } from '../store/users.js';
import { getSiteById } from '../store/read.js';
import { assessTenantReadiness, printReadiness } from '../lib/tenant-provisioning.js';
import { provisionProductTenant, printProvisioning } from '../lib/product-onboarding.js';
import { classifyIndustryFromText } from '../lib/industry-capture.js';
import { callLLMForJson } from '../llm.js';
import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';
import { performRepoConnect } from './connect-repo.js';

// Product-tenant onboarding, the counterpart to onboard-client.js.
//
// It is a separate script rather than a flag on that one because the steps
// genuinely differ: a product tenant does not connect GSC/GA4 (that whole
// step is skipped, not optional), and it DOES need a growth config, a
// conversion event, an industry, a goal and product knowledge — none of
// which a website tenant has. Folding both into one script would mean a
// flag guarding every step in it.
//
//   node server/scripts/onboard-product-client.js <email> <password> --company "Acme" \
//     [--domain acme.com] [--timezone Asia/Kolkata] \
//     [--industry education] [--markets "Nepal,India"] [--icp "counsellors,agents"] \
//     [--conversion-event trial_signup] \
//     [--goal "Reach 200 trial signups a month"] [--goal-type grow_signups] \
//     [--capability "Application tracking"] \
//     [--classify-industry] \
//     [--repo-owner acme --repo-name acme-site ...]
//
// --classify-industry is opt-in because it costs a model call: it fetches
// the homepage and asks for ONE label from the trend-feed catalog's own
// vocabulary. It only runs when neither --industry nor a growth-config
// industry is available, and it never overrides a human value.

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const repeated = { goal: [], capability: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith('--') ? true : (i++, next);
    // --goal and --capability may be repeated; everything else is last-wins.
    if (key in repeated && value !== true) repeated[key].push(value);
    else flags[key] = value;
  }
  return { positional, flags, repeated };
}

const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

async function main() {
  const { positional, flags, repeated } = parseArgs(process.argv.slice(2));
  const [email, password] = positional;

  if (!email || !password || !flags.company) {
    throw new Error(
      'Usage: onboard-product-client.js <email> <password> --company "Name" [--domain example.com] [--timezone ...] ' +
      '[--industry education] [--markets "A,B"] [--icp "A,B"] [--conversion-event trial_signup] ' +
      '[--goal "objective" [--goal-type grow_signups]] [--capability "name"] [--classify-industry] ' +
      '[--repo-owner ... --repo-name ...]'
    );
  }
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await getUserByEmail(normalizedEmail);
  if (existing) throw new Error(`A user with email "${normalizedEmail}" already exists (id ${existing.id}, site ${existing.site_id}).`);

  const passwordHash = await bcrypt.hash(password, 10);

  console.log('Step 1/4 — creating the product site and login...');
  const site = await createClientSite({
    name: flags.company, websiteDomain: flags.domain, timezone: flags.timezone, propertyType: 'product',
  });
  const user = await createUser({ siteId: site.id, email: normalizedEmail, passwordHash });
  console.log(`  Created product site #${site.id} "${site.name}" and user #${user.id} "${normalizedEmail}".`);

  // Fetched BEFORE provisioning so the classification tier has something to
  // read. Best-effort: a homepage that cannot be fetched simply means the
  // industry stays unrecorded and shows up as a missing precondition below,
  // which is the honest outcome.
  let homepageText = null;
  if (flags['classify-industry'] && flags.domain && !flags.industry) {
    const url = /^https?:/.test(flags.domain) ? flags.domain : `https://${flags.domain}`;
    const fetched = await analyzePageUrl(url).catch(() => ({ ok: false }));
    if (fetched.ok && hasSufficientGroundingContent(fetched.analysis)) {
      homepageText = fetched.analysis.bodyText;
      console.log(`  Fetched ${url} for industry classification (${homepageText.length} chars).`);
    } else {
      console.log(`  Could not read ${url} — skipping industry classification.`);
    }
  }

  console.log('\nStep 2/4 — provisioning the product side...');
  const provisioning = await provisionProductTenant(site, {
    industry: typeof flags.industry === 'string' ? flags.industry : null,
    markets: csv(flags.markets),
    icpSignals: csv(flags.icp),
    conversionEvent: typeof flags['conversion-event'] === 'string' ? flags['conversion-event'] : null,
    goals: repeated.goal.map((objective, i) => ({
      objective,
      // One --goal-type applies to the first goal; the rest default inside
      // provisionProductTenant. Repeating --goal with per-goal types is
      // more flag syntax than this is worth — edit the rest in the console.
      goalType: i === 0 && typeof flags['goal-type'] === 'string' ? flags['goal-type'] : undefined,
    })),
    capabilities: repeated.capability.map((name) => ({ name })),
    homepageText,
    deps: {
      classifyIndustry: (text) => classifyIndustryFromText(text, {
        callJson: (system, userText) => callLLMForJson(system, userText, { maxTokens: 200, siteId: site.id }),
      }),
    },
  });
  printProvisioning(provisioning);

  const hasRepoFlags = ['repo-owner', 'repo-name', 'repo-url', 'default-branch', 'tech-stack', 'github-pat-env-var', 'github-app-installation-id', 'url-file-map']
    .some((k) => flags[k] != null);
  console.log('\nStep 3/4 — connecting the GitHub repo...');
  let currentSite = site;
  if (hasRepoFlags) {
    const result = await performRepoConnect(currentSite, flags);
    currentSite = result.site;
  } else {
    console.log('  Skipped — no --repo-owner/--repo-name passed. Run `npm run connect-repo` later.');
  }

  // GSC/GA4 is deliberately absent: a product tenant's readiness check
  // reports it as not-applicable rather than missing, and connect-site
  // remains available for a product that does also have a marketing site.
  console.log('\nStep 4/4 — final readiness check...');
  const fresh = (await getSiteById(site.id)) || currentSite;
  printReadiness(await assessTenantReadiness(fresh));
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('onboard-product-client failed:', err.message);
    await pool.end();
    process.exit(1);
  });
