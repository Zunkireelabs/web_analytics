#!/usr/bin/env node
// Grounded backfill for the design-verification gate.
//
// The gate (implementers/lib/design-drift.js's componentTemplateVerification,
// enforced in routes/action-center.js's generateDraft) treats an UNSTAMPED
// componentTemplate as unverified — which is the honest reading of every
// template stored before provenance existed, since none of them were ever
// checked against a live page. Left alone, that would permanently block every
// faq / expand-content / internal-links / qa-content / content-wrapper draft
// on sites whose templates are, in fact, perfectly good.
//
// This script is the way OUT of that state, and deliberately not a blanket
// "mark everything verified" switch: it runs a real, deterministic check
// (checkTemplateFreshness — fetch the live page, fetch its real
// stylesheets, confirm every class the template claims is actually defined
// in the shipped CSS) and stamps ONLY the templates that genuinely pass. A
// template whose classes no longer exist stays unstamped and stays
// blocked, which is the correct outcome — that is exactly the
// silently-broken-styling case the gate exists to stop. There is no human
// "looks right to me" path into a verified stamp anywhere in this system.
//
// Usage:
//   node server/scripts/verify-component-templates.js --site-id 1
//   node server/scripts/verify-component-templates.js --site-id 1 --apply
//   node server/scripts/verify-component-templates.js --all
//   node server/scripts/verify-component-templates.js --site-id 1 --page-url https://example.com/faq/
//
// Dry run by default (prints the verdict per template, writes nothing);
// --apply performs the stamp. Re-running is always safe: an already-stamped
// template is re-checked and re-stamped with a fresh timestamp, and a
// template that has since gone stale is reported, never silently un-stamped
// (removing a stamp is a deliberate human decision, not this script's call).
import 'dotenv/config';
import { pool } from '../db.js';
import { listSites, getSiteById } from '../store/read.js';
import { updateSiteRepoConfig } from '../db.js';
import {
  COMPONENT_TEMPLATE_KEY,
  checkTemplateFreshness,
  validatePlaceholders,
  stampTemplateVerification,
  TEMPLATE_VERIFIED_BY,
  sitePageUrl,
} from '../implementers/lib/design-drift.js';

function parseArgs(argv) {
  const args = { siteIds: [], all: false, apply: false, pageUrl: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site-id') args.siteIds.push(Number(argv[++i]));
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--page-url') args.pageUrl = argv[++i];
  }
  return args;
}

// The page the freshness check runs against. A component's classes are only
// provably live if they're defined in the CSS the real site actually ships,
// so this needs a real URL: an explicit --page-url when the caller knows a
// page that uses the component, otherwise the site's own homepage (design-drift.js's
// sitePageUrl — the same derivation the autonomous re-derivation path uses when it
// attaches a pageUrl to a queued job, so this script and the live pipeline can never
// disagree about which page a site is verified against). Homepage is a sound default
// because Tailwind builds one stylesheet for the whole site — a class that survived
// the build is present in that bundle whichever page loads it.

async function verifySite(site, { apply, pageUrl: pageUrlOverride }) {
  const templates = site.url_file_map?.siteRoot?.componentTemplates || {};
  const keyByComponent = Object.fromEntries(Object.entries(COMPONENT_TEMPLATE_KEY).map(([a, k]) => [k, a]));
  const entries = Object.entries(templates);

  console.log(`\n=== site #${site.id} — ${site.name} ===`);
  if (!entries.length) {
    console.log('  no componentTemplates configured — nothing to verify');
    console.log('  (drafts for faq/expand-content/internal-links/qa-content/content-wrapper stay blocked until the Design Agent derives one)');
    return { checked: 0, stamped: 0, failed: 0 };
  }

  const pageUrl = pageUrlOverride || sitePageUrl(site);
  if (!pageUrl) {
    console.log('  SKIP: no website_domain or gsc_property on this site, and no --page-url given — cannot verify against a real page');
    return { checked: 0, stamped: 0, failed: entries.length };
  }
  console.log(`  verifying against ${pageUrl}`);

  let stamped = 0;
  let failed = 0;
  const nextTemplates = { ...templates };

  for (const [componentKey, template] of entries) {
    const actionType = keyByComponent[componentKey];
    if (!actionType) {
      console.log(`  - ${componentKey}: SKIP (not a known component-template key)`);
      continue;
    }

    // Structural contract first — cheap, and a template missing a required
    // placeholder can never render correctly no matter how live its CSS is.
    const placeholders = validatePlaceholders(actionType, template);
    if (!placeholders.ok) {
      console.log(`  - ${componentKey}: FAIL — ${placeholders.error}`);
      failed++;
      continue;
    }

    const freshness = await checkTemplateFreshness({ pageUrl, templateEntry: template });
    if (!freshness.ok) {
      // Infra failure, not evidence the template is bad — reported as
      // inconclusive and left unstamped rather than counted as a failure the
      // user should act on. Same fail-open discipline design-drift.js uses.
      console.log(`  - ${componentKey}: INCONCLUSIVE — ${freshness.error}`);
      continue;
    }
    if (freshness.stale) {
      console.log(`  - ${componentKey}: FAIL — ${freshness.missingClasses.length} class(es) no longer defined in the live CSS: ${freshness.missingClasses.slice(0, 8).join(', ')}${freshness.missingClasses.length > 8 ? ', …' : ''}`);
      console.log('      -> stays blocked. Clear url_file_map.siteRoot.componentTemplates for this key so the Design Agent re-derives it on the next draft attempt.');
      failed++;
      continue;
    }

    console.log(`  - ${componentKey}: PASS — all ${freshness.checkedClasses.length} class(es) verified live${apply ? ' → stamping' : ' (dry run, not stamped)'}`);
    nextTemplates[componentKey] = stampTemplateVerification(template, {
      verifiedBy: TEMPLATE_VERIFIED_BY.FRESHNESS_CHECK,
      verifiedRef: pageUrl,
    });
    stamped++;
  }

  if (apply && stamped > 0) {
    await updateSiteRepoConfig({
      siteId: site.id,
      urlFileMap: {
        ...site.url_file_map,
        siteRoot: { ...site.url_file_map?.siteRoot, componentTemplates: nextTemplates },
      },
    });
    console.log(`  applied: ${stamped} template(s) stamped verified`);
  }

  return { checked: entries.length, stamped, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && !args.siteIds.length) {
    console.error('Usage: node server/scripts/verify-component-templates.js (--site-id <id> | --all) [--apply] [--page-url <url>]');
    process.exit(1);
  }

  const sites = args.all
    ? await listSites()
    : (await Promise.all(args.siteIds.map((id) => getSiteById(id)))).filter(Boolean);

  if (!sites.length) {
    console.error('No matching sites found.');
    process.exit(1);
  }

  if (!args.apply) console.log('DRY RUN — nothing will be written. Re-run with --apply to stamp the passing templates.');

  const totals = { checked: 0, stamped: 0, failed: 0 };
  for (const site of sites) {
    const r = await verifySite(site, args);
    totals.checked += r.checked;
    totals.stamped += r.stamped;
    totals.failed += r.failed;
  }

  console.log(`\n${args.apply ? 'Done' : 'Dry run complete'}: ${totals.checked} template(s) checked, ${totals.stamped} verified, ${totals.failed} still blocked.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
