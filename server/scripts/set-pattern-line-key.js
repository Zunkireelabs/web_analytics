import 'dotenv/config';
import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { getRepoTree, getFileContent } from '../github/client.js';
import { updateSiteRepoConfig } from '../db.js';
import { planPatternLineKeys } from '../discovery/url-pattern.js';
import { resolveFile, resolveLineKeys } from '../implementers/lib/url-file-map.js';
import { knownDomain } from '../agents/lib/site-domain.js';

// Tells the platform which front-matter KEY a family of pages keeps its title/description under, when it is not the field's own name.
//   node server/scripts/set-pattern-line-key.js --site-id 8871 --match '^/blog/([^/]+)/?$' --line-key description=excerpt [--yes]
// Only that one pattern changes. Without --yes it only CHECKS: it reads real files of the pattern and says whether the key is there.
// With --yes it saves, reads the map back through the real resolver, and puts the old map back if anything differs.
const argv = process.argv;
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : (argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[i + 1]); };

async function main() {
  const siteId = Number(flag('site-id')); const match = flag('match'); const kv = flag('line-key'); const write = flag('yes') === true;
  if (!siteId || typeof match !== 'string' || typeof kv !== 'string' || !kv.includes('=')) { console.error("Usage: set-pattern-line-key.js --site-id <id> --match '<regex>' --line-key description=excerpt [--yes]"); process.exit(1); }
  const [field, key] = kv.split('=');
  const site = await getSiteById(siteId);
  if (!site?.repo_owner) { console.error('Site not found or no repository.'); process.exit(1); }
  const plan = planPatternLineKeys({ siteMap: site.url_file_map || {}, match, lineKeys: { [field]: key } });
  if (!plan.ok) { console.log(`REFUSED: ${plan.reason}`); process.exit(2); }

  const branch = site.repo_default_branch || 'main';
  const host = knownDomain(site);
  const tree = await getRepoTree(site, branch);
  const pages = (await listPageInventory(siteId, { limit: 5000 })).map((r) => String(r.page || '')).filter(Boolean);
  const after = { ...site, url_file_map: plan.nextMap, website_domain: host };
  const mine = pages.map((p) => ({ page: p, file: resolveFile(after, p) })).filter((x) => x.file && new RegExp(match).test(new URL(x.page).pathname));
  const have = new Set(tree.files.map((f) => (typeof f === 'string' ? f : f.path)));
  const real = mine.filter((x) => have.has(x.file));
  console.log(`\nSite ${siteId} "${site.name}": pattern ${match} covers ${real.length} pages. Setting ${field} -> ${key} (keys now: ${JSON.stringify(plan.lineKeys)}).`);
  let hasKey = 0; let hasField = 0; const sample = real.slice(0, 12);
  for (const x of sample) {
    const txt = await getFileContent(site, x.file, branch).then((r) => (typeof r === 'string' ? r : r?.content || '')).catch(() => '');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt)?.[1] || '';
    if (new RegExp(`^${key}\\s*:`, 'm').test(fm)) hasKey += 1;
    if (new RegExp(`^${field}\\s*:`, 'm').test(fm)) hasField += 1;
  }
  console.log(`Looked at ${sample.length} of its files: ${hasKey} have a "${key}:" line, ${hasField} already have a "${field}:" line.`);
  if (hasKey === 0) { console.log(`REFUSED: none of the sampled files has a "${key}:" line.`); process.exit(2); }
  if (hasField > 0) { console.log(`REFUSED: ${hasField} sampled file(s) already have their own "${field}:" line; one key for the whole family would put the marker on the wrong line there.`); process.exit(2); }
  if (!write) { console.log('\nCHECK ONLY. Nothing was saved. Add --yes to save.'); return; }

  const old = site.url_file_map || {};
  await updateSiteRepoConfig({ siteId, urlFileMap: plan.nextMap });
  const saved = await getSiteById(siteId);
  const bad = real.filter((x) => resolveLineKeys({ ...saved, website_domain: host }, x.page, 'meta-title')?.[field] !== key);
  if (bad.length) { await updateSiteRepoConfig({ siteId, urlFileMap: old }); console.log(`\nROLLED BACK: ${bad.length} page(s) did not resolve the key after saving. The map is as it was.`); process.exit(3); }
  console.log(`\nSAVED and read back: all ${real.length} pages resolve ${field} -> ${key}.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
