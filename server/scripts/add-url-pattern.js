import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { getRepoTree } from '../github/client.js';
import { updateSiteRepoConfig } from '../db.js';
import { planUrlPattern, planPageEntries } from '../discovery/url-pattern.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { knownDomain } from '../agents/lib/site-domain.js';

// Changes ONE project's url_file_map (page address -> template file), strictly checked, in one of three ways:
//
//   ADD a pattern for a family of pages:
//     node server/scripts/add-url-pattern.js --site-id 8872 --match '^/blog/([^/]+)/?$' --file 'src/blog/$1.njk'
//   REPLACE the file of a pattern that already exists (it points at the wrong file):
//     node server/scripts/add-url-pattern.js --site-id 8871 --match '^/blog/([^/]+)/?$' --file 'src/content/blog/$1.md' --replace
//   ADD exact pages (a home page, a contact page); repeat --page/--file as a pair:
//     node server/scripts/add-url-pattern.js --site-id 8874 --page / --file src/index.njk --page /contact --file src/contact/index.njk
//
// Without --yes it only CHECKS and prints what would change. It refuses unless every page it changes resolves to a file that exists in
// the repository. With --yes it saves, reads the map back through the same resolver the daily run uses, and puts the old map back if
// anything resolves differently. It changes one column (sites.url_file_map) of one project.

const argv = process.argv;
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };
const multi = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));

async function main() {
  const siteId = Number(flag('site-id')); const write = flag('yes') === true;
  const pagePaths = multi('page'); const match = flag('match'); const replace = flag('replace') === true;
  const files = multi('file');
  const usage = "Usage: add-url-pattern.js --site-id <id> (--match '<regex>' --file '<path with $1>' [--replace] | --page </path> --file <path> [--page ... --file ...]) [--yes]";
  if (!siteId || (!pagePaths.length && typeof match !== 'string') || !files.length) { console.error(usage); process.exit(1); }
  if (pagePaths.length && pagePaths.length !== files.length) { console.error('Each --page needs its own --file.\n' + usage); process.exit(1); }

  const site = await getSiteById(siteId);
  if (!site) { console.error(`Site ${siteId} not found.`); process.exit(1); }
  if (!site.repo_owner || !site.repo_name) { console.error('No repository connected.'); process.exit(1); }
  const branch = site.repo_default_branch || 'main';
  const tree = await getRepoTree(site, branch);
  const host = knownDomain(site);
  console.log(`\nSite ${siteId} "${site.name}" ${site.repo_owner}/${site.repo_name}@${branch}: ${tree.files.length} repository files.${tree.truncated ? ' (file list truncated: only makes the check stricter)' : ''}`);

  let plan; let expect;
  if (pagePaths.length) {
    plan = planPageEntries({ siteMap: site.url_file_map || {}, entries: pagePaths.map((path, i) => ({ path, file: files[i] })), repoFiles: tree.files });
    expect = (plan.added || []).map((a) => ({ page: `https://${host}${a.path === '/' ? '/' : a.path}`, file: a.file }));
  } else {
    const pages = (await listPageInventory(siteId, { limit: 5000 })).map((r) => String(r.page || '')).filter(Boolean);
    plan = planUrlPattern({ siteMap: site.url_file_map || {}, match, file: files[0], pages, repoFiles: tree.files, host, replace });
    expect = plan.newlyMapped || [];
    console.log(`${pages.length} pages known.`);
  }
  if (!plan.ok) { console.log(`REFUSED: ${plan.reason}`); (plan.misses || []).slice(0, 10).forEach((m) => console.log(`  - ${m.page} -> ${m.file}`)); process.exit(2); }
  console.log(`OK: ${expect.length} page(s) ${plan.replaced ? `now resolve to the new file (was ${plan.replaced})` : 'newly resolve'} to files that exist.`);
  expect.slice(0, 8).forEach((m) => console.log(`  ${m.page} -> ${m.file}`));
  if (expect.length > 8) console.log(`  ... and ${expect.length - 8} more`);
  if (!write) { console.log('\nCHECK ONLY. Nothing was saved. Add --yes to save.'); return; }

  const old = site.url_file_map || {};
  await updateSiteRepoConfig({ siteId, urlFileMap: plan.nextMap });
  const saved = await getSiteById(siteId);
  const bad = expect.filter((m) => resolveFile(saved, m.page) !== m.file);
  if (bad.length) {
    await updateSiteRepoConfig({ siteId, urlFileMap: old });
    console.log(`\nROLLED BACK: ${bad.length} page(s) did not resolve as planned after saving, e.g. ${bad[0].page}. The map is as it was.`);
    process.exit(3);
  }
  console.log(`\nSAVED and read back: all ${expect.length} pages resolve to their files.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
