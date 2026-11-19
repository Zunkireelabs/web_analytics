import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { getRepoTree, getFileContent } from '../github/client.js';
import { updateSiteRepoConfig } from '../db.js';
import { planHeadTargets } from '../discovery/head-targets.js';
import { resolveActionFile } from '../implementers/lib/url-file-map.js';
import { knownDomain } from '../agents/lib/site-domain.js';

// Points open-graph and canonical fixes at the per-page head include that really holds those tags (an Eleventy site converted from static HTML:
// the page's front matter names it, `"headInclude": "heads/<page>.njk"`, under src/_includes/). Everything else stays on the page file.
//
//   node server/scripts/configure-head-targets.js --site-id 8874          CHECK: prints which pages would be configured, and why any are not
//   node server/scripts/configure-head-targets.js --site-id 8874 --yes    saves it
//
// A page is configured only when its head file exists and holds tags the fix can adopt. With --yes the map is saved, read back through the
// resolver the daily run uses, and the old map is restored if any page resolves differently. One column (sites.url_file_map) of one project.
// Run it AFTER the page list is complete (force-site-discovery) and the URL patterns are in place, so every page is covered.

const argv = process.argv;
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };

async function main() {
  const siteId = Number(flag('site-id')); const write = flag('yes') === true;
  if (!siteId) { console.error('Usage: node server/scripts/configure-head-targets.js --site-id <id> [--yes]'); process.exit(1); }
  const site = await getSiteById(siteId);
  if (!site) { console.error(`Site ${siteId} not found.`); process.exit(1); }
  if (!site.repo_owner || !site.repo_name) { console.error('No repository connected.'); process.exit(1); }
  const branch = site.repo_default_branch || 'main';
  const tree = await getRepoTree(site, branch);
  const pages = (await listPageInventory(siteId, { limit: 5000 })).map((r) => String(r.page || '')).filter(Boolean);
  const cache = new Map();
  const readFile = async (path) => { if (!cache.has(path)) { const f = await getFileContent(site, path, branch).catch(() => null); cache.set(path, f ? f.content : null); } return cache.get(path); };
  const host = knownDomain(site);

  console.log(`\nSite ${siteId} "${site.name}" ${site.repo_owner}/${site.repo_name}@${branch}: ${pages.length} pages known, ${tree.files.length} repository files.`);
  const plan = await planHeadTargets({ siteMap: site.url_file_map || {}, pages, host, repoFiles: tree.files, readFile });
  const reasons = {};
  for (const s of plan.skipped || []) reasons[s.reason.replace(/src\/_includes\/\S+/, '<head file>')] = (reasons[s.reason.replace(/src\/_includes\/\S+/, '<head file>')] || 0) + 1;
  if (!plan.ok) { console.log(`NOTHING TO CONFIGURE: ${plan.reason}`); console.log('  why pages were skipped:', JSON.stringify(reasons)); process.exit(2); }
  console.log(`OK: ${plan.configured.length} page(s) would send ${plan.configured[0].types.join(' and ')} to their own head file.`);
  plan.configured.slice(0, 6).forEach((c) => console.log(`  ${c.page}  ${c.types.join('+')} -> ${c.headFile}`));
  if (plan.configured.length > 6) console.log(`  ... and ${plan.configured.length - 6} more`);
  if (plan.skipped.length) console.log(`  not configured (${plan.skipped.length}): ${JSON.stringify(reasons)}`);
  if (!write) { console.log('\nCHECK ONLY. Nothing was saved. Add --yes to save.'); return; }

  const old = site.url_file_map || {};
  await updateSiteRepoConfig({ siteId, urlFileMap: plan.nextMap });
  const saved = await getSiteById(siteId);
  const bad = [];
  for (const c of plan.configured) for (const t of c.types) if (resolveActionFile(saved, c.page, t) !== c.headFile) bad.push(`${c.page} ${t}`);
  if (bad.length) { await updateSiteRepoConfig({ siteId, urlFileMap: old }); console.log(`\nROLLED BACK: ${bad.length} did not resolve as planned after saving, e.g. ${bad[0]}. The map is as it was.`); process.exit(3); }
  console.log(`\nSAVED and read back: ${plan.configured.length} page(s) resolve to their head files.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
