#!/usr/bin/env node
// Implements the remediation verify-component-templates.js's own output already
// prescribes for a FAIL: "Clear url_file_map.siteRoot.componentTemplates for
// this key so the Design Agent re-derives it on the next draft attempt." That
// script only ever reports; nothing before this actually performed the clear.
//
// Real case this was built from: Chayce (site 8864) had all 5 of its
// componentTemplates entries (faq, qaContent, expandContent, internalLinks,
// contentWrapper) captured against a design the site no longer ships —
// checkTemplateFreshness/checkTemplateStructuralMatch confirmed every one
// FAIL — which was silently abandoning every faq/expand-content/qa-content/
// internal-links/content-wrapper draft with "template-stale" at apply time
// (server/implementers/backend.js's componentTemplateVerification gate).
//
// Deliberately narrow: runs the exact same checks verify-component-templates.js
// uses and clears ONLY the keys that FAIL right now — a PASS or INCONCLUSIVE
// key is left untouched. Clearing (not rewriting) is the whole fix: on the
// next draft attempt, design-drift.js's derivation path re-composes a fresh
// template from the site's own stored design profile (projectComponentTemplate)
// and re-verifies it against the live page before stamping — see
// implementers/lib/design-drift.js's "PROJECT FROM THE SITE'S DESIGN LANGUAGE
// FIRST" block. This script never invents or hand-writes a class name itself.
//
// Usage:
//   node server/scripts/clear-stale-component-templates.js --site-id 8864
//   node server/scripts/clear-stale-component-templates.js --site-id 8864 --apply
//
// Dry run by default; --apply performs the write.
import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { updateSiteRepoConfig } from '../db.js';
import {
  COMPONENT_TEMPLATE_KEY,
  checkTemplateFreshness,
  checkTemplateStructuralMatch,
  validatePlaceholders,
  sitePageUrl,
} from '../implementers/lib/design-drift.js';

function parseArgs(argv) {
  const args = { siteId: null, apply: false, pageUrl: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site-id') args.siteId = Number(argv[++i]);
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--page-url') args.pageUrl = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.siteId) {
    console.error('Usage: node server/scripts/clear-stale-component-templates.js --site-id <id> [--apply] [--page-url <url>]');
    process.exit(1);
  }

  const site = await getSiteById(args.siteId);
  if (!site) {
    console.error(`No site ${args.siteId} found.`);
    process.exit(1);
  }

  const templates = site.url_file_map?.siteRoot?.componentTemplates || {};
  const keyByComponent = Object.fromEntries(Object.entries(COMPONENT_TEMPLATE_KEY).map(([a, k]) => [k, a]));
  const entries = Object.entries(templates);

  console.log(`=== site #${site.id} — ${site.name} ===`);
  if (!entries.length) {
    console.log('  no componentTemplates configured — nothing to clear');
    return;
  }

  const pageUrl = args.pageUrl || sitePageUrl(site);
  if (!pageUrl) {
    console.error('  no website_domain/gsc_property on this site, and no --page-url given — cannot check against a real page');
    process.exit(1);
  }
  console.log(`  checking against ${pageUrl}`);

  const staleKeys = [];
  const kept = { ...templates };

  for (const [componentKey, template] of entries) {
    const actionType = keyByComponent[componentKey];
    if (!actionType) {
      console.log(`  - ${componentKey}: SKIP (not a known component-template key)`);
      continue;
    }

    const placeholders = validatePlaceholders(actionType, template);
    if (!placeholders.ok) {
      console.log(`  - ${componentKey}: FAIL (invalid placeholders: ${placeholders.error}) -> clearing`);
      staleKeys.push(componentKey);
      continue;
    }

    const freshness = await checkTemplateFreshness({ pageUrl, templateEntry: template });
    if (!freshness.ok) {
      console.log(`  - ${componentKey}: INCONCLUSIVE (${freshness.error}) -> left as-is`);
      continue;
    }
    if (freshness.stale) {
      console.log(`  - ${componentKey}: FAIL (${freshness.missingClasses.length} class(es) no longer live: ${freshness.missingClasses.slice(0, 8).join(', ')}) -> clearing`);
      staleKeys.push(componentKey);
      continue;
    }

    const structural = await checkTemplateStructuralMatch({ pageUrl, templateEntry: template, html: freshness.html });
    if (!structural.ok) {
      console.log(`  - ${componentKey}: INCONCLUSIVE (${structural.error}) -> left as-is`);
      continue;
    }
    if (structural.structurallyStale) {
      console.log(`  - ${componentKey}: FAIL (captured shape gone: ${structural.missingStructure.join(', ')}) -> clearing`);
      staleKeys.push(componentKey);
      continue;
    }

    console.log(`  - ${componentKey}: PASS -> left as-is`);
  }

  if (!staleKeys.length) {
    console.log('\nNo stale templates found. Nothing to clear.');
    return;
  }
  for (const key of staleKeys) delete kept[key];

  console.log(`\n${staleKeys.length} stale key(s): ${staleKeys.join(', ')}`);
  if (!args.apply) {
    console.log('Dry run. Re-run with --apply to clear them.');
    return;
  }

  await updateSiteRepoConfig({
    siteId: site.id,
    urlFileMap: {
      ...site.url_file_map,
      siteRoot: { ...site.url_file_map?.siteRoot, componentTemplates: kept },
    },
  });
  console.log(`Cleared: ${staleKeys.join(', ')}. The Design Agent will re-derive each from this site's own design profile (and re-verify against the live page) the next time a draft needs it.`);
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
