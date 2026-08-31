#!/usr/bin/env node
// Re-runs the deterministic role corrections over already-CAPTURED design
// profiles, then re-projects and re-verifies the affected component templates.
//
// WHY THIS EXISTS
//
// A profile derived before the role-assignment fixes can have real, live,
// perfectly-defined classes sitting in entirely the wrong slots — this
// platform's first client had its eyebrow/kicker style as typography.body, its
// page <h1> style as typography.heading.section, and its primary CTA button as
// typography.link. Every component template projected from that was wrong, and
// every one still passed verification, because verification only asked whether
// the classes EXIST.
//
// The normal repair is to re-derive from scratch, which needs Playwright plus
// a model call. That is right when a site's design has actually changed. It is
// overkill here: the capture is fine. capture.js recorded the real tags, class
// strings and computed styles for every page, and they are still in the
// profile's own `pages` array. The defect was purely in which of those the
// role slots point at — and correctBodyTypography / correctHeadingTypography /
// correctLinkTypography decide that deterministically, from that same stored
// evidence, with no network and no model.
//
// MULTI-TENANT: a role misassignment is a property of the DERIVATION, not of
// any one tenant, so every site whose profile predates the fix carries the same
// defect. --all is therefore the mode that matters; --site exists for
// re-checking one tenant. Each site is independent: one tenant's failure never
// aborts the run, and no state is shared between them.
//
// Idempotent — run it on an already-correct profile and it reports no changes.
// Templates are re-projected from the corrected profile and re-verified against
// each site's own live pages, so anything still wrong is left UNVERIFIED rather
// than re-stamped, which is the whole point of the incident this repairs.
//
//   node server/scripts/repair-design-profile-roles.js --all
//   node server/scripts/repair-design-profile-roles.js --all --commit
//   node server/scripts/repair-design-profile-roles.js --site 1 --show

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { query } from '../db.js';
import {
  correctBodyTypography, bodySamples,
  correctHeadingTypography, headingSamplesByLevel,
  correctLinkTypography,
} from '../design-agent/live-analysis/profile-extract.js';
import { projectAllComponentTemplates, isProfileUsable } from '../design-agent/lib/design-profile.js';
import { verifyTemplateAgainstLiveSite, COMPONENT_TEMPLATE_KEY, sitePageUrl } from '../implementers/lib/design-drift.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const siteId = Number(arg('site'));
const all = process.argv.includes('--all');
const commit = process.argv.includes('--commit');
const show = process.argv.includes('--show');

if (!siteId && !all) {
  console.error('Usage: repair-design-profile-roles.js (--site <id> | --all) [--commit] [--show]');
  process.exit(1);
}

// select * — sitePageUrl reads whichever of the site's URL columns is
// populated, so a narrowed projection silently makes every template
// "unreachable" and the whole repair a no-op that looks like success.
const { rows: sites } = all
  ? await query(`select * from sites
       where url_file_map->'siteRoot'->'designProfile' is not null
       order by id`)
  : await query('select * from sites where id = $1', [siteId]);

if (!sites.length) {
  console.error(all ? 'No site has a stored design profile.' : `No site ${siteId}.`);
  process.exit(1);
}

let changed = 0;
let failed = 0;
for (const site of sites) {
  try {
    if (await repairSite(site)) changed++;
  } catch (err) {
    // One tenant's failure must never abort the fleet run.
    failed++;
    console.error(`  ! site ${site.id}: ${err.message}`);
  }
}

console.log(`\n${sites.length} site(s) examined, ${changed} with role corrections, ${failed} failed.`);
if (!commit) console.log('Dry run — re-run with --commit to write.');
process.exit(failed ? 1 : 0);

async function repairSite(site) {
  const urlFileMap = site.url_file_map || {};
  const siteRoot = urlFileMap.siteRoot || {};
  const profile = siteRoot.designProfile;

  console.log(`\n=== ${site.name} (site ${site.id}) ===`);
  if (!profile) {
    console.log('  no stored design profile — nothing to repair.');
    return false;
  }

  const changes = [];
  const note = (slot, was, now) => {
    if (JSON.stringify(was) === JSON.stringify(now)) return;
    changes.push(slot);
    console.log(`  ${slot}\n     was: ${JSON.stringify(was)}\n     now: ${JSON.stringify(now)}`);
  };

  const typography = profile.typography || {};
  const { body } = correctBodyTypography(typography.body || null, bodySamples(profile.pages));
  const { heading } = correctHeadingTypography(typography.heading || {}, headingSamplesByLevel(profile.pages));
  const { link } = correctLinkTypography(typography.link || null, profile.components || {});

  note('typography.body', typography.body, body);
  note('typography.heading.section', typography.heading?.section, heading.section);
  note('typography.heading.item', typography.heading?.item, heading.item);
  note('typography.link', typography.link, link);
  if (!changes.length) console.log('  roles already correct.');

  const repaired = {
    ...profile,
    typography: { ...typography, body, heading, link },
    repairedAt: new Date().toISOString(),
    repairedBy: 'repair-design-profile-roles',
  };

  if (!isProfileUsable(repaired)) {
    // Not a crash: for this tenant no captured element qualified as body copy,
    // so there is no honest correction to make and a real re-derivation is the
    // only fix. Leaving the profile alone is correct — overwriting it with
    // something unusable would take the site from wrong to broken.
    console.log('  repaired profile would be unusable — left untouched; this site needs a real re-derivation.');
    return false;
  }

  // Re-project and re-verify against THIS site's own live pages. A template
  // that cannot be verified is left OUT rather than written unverified: an
  // absent template falls back to the generator default, which is plain but
  // never wrong, while a wrongly-stamped one is what caused the incident.
  const projected = projectAllComponentTemplates(repaired);
  const pageUrl = sitePageUrl(site);
  const verified = {};
  for (const [actionType, template] of Object.entries(projected)) {
    // COMPONENT_TEMPLATE_KEY, NOT componentTemplateActionTypeFor — the latter
    // is the INVERSE map (generatorId -> actionType) and returns an actionType
    // unchanged, so using it wrote hyphenated 'expand-content' keys that
    // nothing reads. Templates stored under a name no consumer looks up are
    // invisible: every generator silently falls back to its plain default, and
    // the repair looks like it worked.
    const key = COMPONENT_TEMPLATE_KEY[actionType];
    if (!key) throw new Error(`No componentTemplates key for action type "${actionType}"`);

    const result = await verifyTemplateAgainstLiveSite(actionType, template, { pageUrl })
      .catch((err) => ({ ok: false, reason: 'unreachable', error: err.message }));
    if (result.ok) {
      verified[key] = result.stamped;
      console.log(`  ✓ ${key}`);
      if (show) {
        for (const part of ['wrapper', 'row']) {
          if (template[part]) console.log(`      ${part}: ${template[part].replace(/\n/g, '\n      ')}`);
        }
      }
    } else {
      console.log(`  ✗ ${key} — ${result.reason}${result.error ? `: ${result.error}` : ''}`);
    }
  }

  if (!commit) return changes.length > 0;

  // Snapshot the exact prior value first. This overwrites a production column
  // five generators read on every draft, and "re-derive it again" is not a
  // restore — a fresh derivation is a different computation with a different
  // result. A file on disk is a real undo.
  const backupPath = `design-profile-backup-site-${site.id}-${Date.now()}.json`;
  await writeFile(backupPath, JSON.stringify({
    siteId: site.id,
    takenAt: new Date().toISOString(),
    designProfile: siteRoot.designProfile,
    componentTemplates: siteRoot.componentTemplates,
  }, null, 2));

  await query('update sites set url_file_map = $1 where id = $2', [{
    ...urlFileMap,
    siteRoot: { ...siteRoot, designProfile: repaired, componentTemplates: verified },
  }, site.id]);

  console.log(`  written (${Object.keys(verified).length} verified template(s)); prior value in ${backupPath}`);
  return changes.length > 0;
}
