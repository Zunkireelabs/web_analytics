import 'dotenv/config';
import { pool } from '../db.js';
import { getSiteById } from '../store/read.js';
import { updateSiteRepoConfig } from '../db.js';
import { getDesignProfile } from '../implementers/lib/design-drift.js';
import {
  detectInlineProseMode, planInlineProseWrite, articleUrlsFromProfile, projectedH2PxFromProfile,
} from '../design-agent/live-analysis/inline-prose-detect.js';

// Detect a site's `siteRoot.inlineProse` from its own human-written articles.
//
//   node server/scripts/detect-inline-prose.js --site-id 1            # report only
//   node server/scripts/detect-inline-prose.js --site-id 1 --apply    # write it
//
// Report-only by default. A hand-set value is NEVER overwritten: a
// disagreement is printed, not resolved. Validate against site 1 first — it
// has the one confirmed ground truth (inlineProse 'layout', 2026-10-02).

const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(`--${k}`); return i === -1 ? null : (args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[i + 1]); };

async function main() {
  const siteId = Number(flag('site-id'));
  if (!siteId) throw new Error('Usage: detect-inline-prose.js --site-id <id> [--apply]');
  const site = await getSiteById(siteId);
  if (!site) throw new Error(`No site ${siteId}.`);

  const profile = getDesignProfile(site);
  const urls = articleUrlsFromProfile(profile);
  console.log(`Site ${siteId}: ${urls.length} captured human-written article(s): ${urls.join(', ') || '(none)'}`);

  const detected = await detectInlineProseMode({ articleUrls: urls, projectedH2Px: projectedH2PxFromProfile(profile) });
  console.log('Detected:', JSON.stringify(detected, null, 2));

  const current = site.url_file_map?.siteRoot?.inlineProse;
  const plan = planInlineProseWrite(current, detected);
  console.log(`Currently set: ${current ?? '(unset)'} → ${plan.write ? `would write "${plan.mode}"` : `no write (${plan.reason})`}`);
  if (plan.mismatch) console.log(`MISMATCH — configured "${plan.mismatch.configured}", detector says "${plan.mismatch.detected}". Left as configured; look at it.`);

  if (plan.write && flag('apply')) {
    const map = site.url_file_map || {};
    await updateSiteRepoConfig({ siteId, urlFileMap: { ...map, siteRoot: { ...(map.siteRoot || {}), inlineProse: plan.mode } } });
    console.log(`Wrote siteRoot.inlineProse = "${plan.mode}".`);
  } else if (plan.write) {
    console.log('Report only — pass --apply to write it.');
  }
}

main().then(() => pool.end()).catch(async (err) => { console.error('detect-inline-prose failed:', err.message); await pool.end(); process.exit(1); });
