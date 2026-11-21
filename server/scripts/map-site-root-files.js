// Maps each client's robots.txt / llms.txt / sitemap source file in url_file_map.siteRoot, so the generators that maintain those files know
// where they live (llms-txt, robots-fix, robots-bootstrap, sitemap). Nothing is guessed: every path below was read in the client's own repo
// on 2026-11-21, and the script re-checks that each one exists on the repo's base branch before it writes anything.
//
// Deliberately NOT mapped:
//   - a sitemap that is a TEMPLATE or framework-generated (zunkireelabs-web src/sitemap.njk, web-zenly src/sitemap.njk, superrank-web's Astro
//     integration). Those rebuild themselves from the site's pages, and the sitemap generator refuses to write into one (sitemap-guard.js).
//     The sitemap agent now monitors them without a mapping.
//   - the sitemap of a site that is already mapped (chayce src/sitemap.njk): not touched here.
//
//   node server/scripts/map-site-root-files.js            # dry run: what would change, checked against each repo, nothing written
//   node server/scripts/map-site-root-files.js --apply    # write it
import 'dotenv/config';
import { pool, updateSiteRepoConfig } from '../db.js';
import { getRepoTree, getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { isTemplatedSitemap } from '../implementers/lib/sitemap-guard.js';
import { execFileSync } from 'node:child_process';

export const PLAN = Object.freeze({
  8864: { why: 'chayce: llmsTxt points at src/llms.txt, which does not exist; the real source is src/llms.njk', siteRoot: { llmsTxt: 'src/llms.njk' } },
  8871: { why: 'superrank: nothing mapped; plain files in public/', siteRoot: { robotsTxt: 'public/robots.txt', llmsTxt: 'public/llms.txt', nginxConfig: 'nginx/static.conf' } },
  8872: { why: 'zennly (web-zenly): nothing mapped; templates in src/ (the write guard keeps their front matter)', siteRoot: { robotsTxt: 'src/robots.njk', llmsTxt: 'src/llms.njk', nginxConfig: 'nginx/static.conf' } },
  8874: { why: 'mobilise: nothing mapped; static files in src/assets/ (the sitemap is hand-maintained)', siteRoot: { sitemap: 'src/assets/sitemap.xml', robotsTxt: 'src/assets/robots.txt', llmsTxt: 'src/assets/llms.txt', nginxConfig: 'nginx/static.conf' } },
});

// Pure: the siteRoot after applying `changes`, every other key kept, and the list of keys that actually change.
export function mergeSiteRoot(urlFileMap, changes) {
  const current = urlFileMap?.siteRoot || {};
  const changed = Object.entries(changes).filter(([k, v]) => current[k] !== v).map(([k]) => k);
  return { changed, urlFileMap: changed.length ? { ...urlFileMap, siteRoot: { ...current, ...changes } } : urlFileMap };
}

// A client with its own GitHub App cannot be read from a machine that lacks that App's key. The operator's own `gh` login can read the same
// repos, so it is the fallback for this one read-only check (an argument list, never a shell string).
function ghReadTree(site) {
  const out = execFileSync('gh', ['api', `repos/${site.repo_owner}/${site.repo_name}/git/trees/${baseBranch(site)}?recursive=1`, '--jq', '.tree[].path'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set(out.split('\n').filter(Boolean));
}
function ghReadFile(site, path) {
  try {
    const b64 = execFileSync('gh', ['api', `repos/${site.repo_owner}/${site.repo_name}/contents/${path}?ref=${baseBranch(site)}`, '--jq', '.content'], { encoding: 'utf8' });
    return { content: Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8') };
  } catch { return null; }
}

async function main() {
  const apply = process.argv.includes('--apply');
  let problems = 0;
  for (const [idText, plan] of Object.entries(PLAN)) {
    const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [Number(idText)]);
    if (!site) { console.log(`site ${idText}: not found`); problems++; continue; }
    const { changed, urlFileMap } = mergeSiteRoot(site.url_file_map || {}, plan.siteRoot);
    console.log(`\nsite ${site.id} ${site.website_domain}: ${plan.why}`);
    if (!changed.length) { console.log('  already mapped as planned.'); continue; }
    let files = null, via = 'GitHub App';
    try { files = new Set((await getRepoTree(site, baseBranch(site))).files); } catch { /* try gh below */ }
    if (!files) { try { files = ghReadTree(site); via = 'gh login'; } catch (e) { console.log(`  cannot read the repo (${String(e.message).split('\n')[0].slice(0, 100)}), so nothing can be verified.`); } }
    let ok = Boolean(files);
    if (files) console.log(`  repo read via ${via}`);
    for (const key of changed) {
      const path = plan.siteRoot[key];
      const exists = files ? files.has(path) : null;
      let note = exists === null ? 'cannot verify' : exists ? 'exists in the repo' : 'DOES NOT EXIST in the repo';
      if (exists && key === 'sitemap') {
        const f = via === 'gh login' ? ghReadFile(site, path) : await getFileContent(site, path, baseBranch(site)).catch(() => null);
        if (!f || isTemplatedSitemap(f.content)) { note = 'is a template (or unreadable), not a static sitemap'; ok = false; }
        else note = 'exists and is a static sitemap';
      }
      if (!exists) ok = false;
      console.log(`  ${key}: ${site.url_file_map?.siteRoot?.[key] ?? '(none)'} -> ${path}   [${note}]`);
    }
    if (!ok) { console.log('  NOT applying this site: a check failed.'); problems++; continue; }
    if (apply) { await updateSiteRepoConfig({ siteId: site.id, urlFileMap }); console.log('  written. Everything else in url_file_map is unchanged.'); }
  }
  if (!apply) console.log('\nDry run: nothing written. Re-run with --apply to write it.');
  if (problems) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => pool.end()).catch((err) => { console.error(err.message); pool.end(); process.exit(1); });
}
