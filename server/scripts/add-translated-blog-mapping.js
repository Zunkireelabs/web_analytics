// Gives every translated blog post of a site a source file to be fixed in, with ONE rule instead of one entry per post.
//
// zunkireelabs-web keeps its translated posts at src/<lang>/blog/<slug>.md. 81 of them had an explicit url_file_map entry; the 43 newer
// ones had none, so a fix for them had nowhere to apply, and every future translated post would have hit the same wall. The rule maps
//   /<lang>/blog/<slug>/   ->   src/<lang>/blog/<slug>.md
// Explicit page entries still win over a rule, so nothing already mapped changes.
//
// Before writing anything (and in the dry run) it checks against the site's real repo that the file each currently-unmapped listed
// post would resolve to actually exists, and reports any that do not.
//
//   node server/scripts/add-translated-blog-mapping.js --site-id 1            # dry run: what would change, nothing written
//   node server/scripts/add-translated-blog-mapping.js --site-id 1 --apply    # write it
import 'dotenv/config';
import { pool, updateSiteRepoConfig } from '../db.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { getRepoTree } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';

export const TRANSLATED_BLOG_RULE = Object.freeze({ match: '^/(nl|de|de-ch)/blog/([^/]+)/?$', file: 'src/$1/blog/$2.md' });

export function withTranslatedBlogRule(urlFileMap) {
  const patterns = Array.isArray(urlFileMap?.patterns) ? urlFileMap.patterns : [];
  if (patterns.some((p) => p.match === TRANSLATED_BLOG_RULE.match)) return { changed: false, urlFileMap };
  return { changed: true, urlFileMap: { ...urlFileMap, patterns: [...patterns, { ...TRANSLATED_BLOG_RULE }] } };
}

async function main() {
  const args = process.argv.slice(2);
  const siteId = Number(args[args.indexOf('--site-id') + 1]);
  const apply = args.includes('--apply');
  if (!siteId) throw new Error('Usage: node server/scripts/add-translated-blog-mapping.js --site-id <id> [--apply]');
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [siteId]);
  if (!site) throw new Error(`No site ${siteId}.`);
  const { changed, urlFileMap } = withTranslatedBlogRule(site.url_file_map || {});
  if (!changed) { console.log('The translated-blog rule is already there. Nothing to do.'); return; }

  const origin = `https://${String(site.website_domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
  const { rows } = await pool.query("SELECT page FROM page_inventory WHERE site_id = $1 AND page ~ '/(nl|de|de-ch)/blog/[^/]+/?$'", [siteId]);
  const before = { ...site, url_file_map: site.url_file_map };
  const after = { ...site, url_file_map: urlFileMap };
  const newly = rows.map((r) => r.page).filter((u) => !resolveFile(before, u) && resolveFile(after, u));
  const tree = await getRepoTree(site, baseBranch(site)).catch((e) => { console.log(`(could not read the repo to verify files: ${e.message})`); return null; });
  const files = tree ? new Set(tree.files) : null;
  const missing = files ? newly.filter((u) => !files.has(resolveFile(after, u))) : [];

  console.log(`Site ${siteId}: ${rows.length} translated blog post(s) in the inventory; ${newly.length} would newly resolve to a file.`);
  if (files) console.log(`Verified against the repo: ${newly.length - missing.length} of those files exist${missing.length ? `, ${missing.length} do NOT:\n  ${missing.slice(0, 10).join('\n  ')}` : '.'}`);
  console.log(`Rule to add: ${JSON.stringify(TRANSLATED_BLOG_RULE)}`);
  if (!apply) { console.log('\nDry run: nothing written. Re-run with --apply to write it.'); return; }
  if (missing.length) { console.log('\nNot writing: some mapped files do not exist. Fix those first.'); process.exitCode = 1; return; }
  await updateSiteRepoConfig({ siteId, urlFileMap });
  console.log('\nWritten. Everything else in url_file_map is unchanged.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end(); process.exit(1); });
}
