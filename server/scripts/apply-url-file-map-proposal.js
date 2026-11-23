import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { merge3 } from '../lib/json-merge3.js';

// Applies a REVIEWED url_file_map proposal (docs/audits/2026-11-23-six-client-remediation/proposals/) to ONE site,
// merged onto the map as it is NOW — never by replacing the map with an old snapshot. It is a three-way merge:
//   base     the map the proposal was written against (base-<site>.json)
//   current  the row in the database right now (read under a row lock when applying)
//   proposed the map the reviewers approved
// A key that only the proposal changed is taken; a key that only someone else changed is kept; a key both changed
// differently is a CONFLICT and nothing is written. DRY-RUN BY DEFAULT: it reads, prints the plan and writes nothing
// unless --apply is passed.
//
//   node server/scripts/apply-url-file-map-proposal.js --site 1    --proposal zunkiree-1-proposed-map.json
//   node server/scripts/apply-url-file-map-proposal.js --site 8862 --proposal admizz-8862-phase1-config-only-map.json
//   node server/scripts/apply-url-file-map-proposal.js --site 8862 --proposal admizz-8862-phase2-needs-engine-map.json --engine-deployed
//   add --apply to write
//
// Phase 2 (page-data-object on `{...post}` pages) needs the engine change in this PR to be DEPLOYED first, or those
// adapters would be configured but refuse every draft. It therefore refuses to run without --engine-deployed.
// Only sites 1 and 8862 are allowed; a proposal can never be applied to another site.

export const PROPOSAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/audits/2026-11-23-six-client-remediation/proposals');
export const ALLOWED_SITES = new Set([1, 8862]);

const keys = (o) => Object.keys(o || {});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function planProposal(base, current, proposed) {
  const { merged, conflicts } = merge3(base, current, proposed);
  const cp = current.pages || {}; const mp = merged.pages || {};
  const summary = {
    pagesAdded: keys(mp).filter((k) => !(k in cp)),
    pagesRemoved: keys(cp).filter((k) => !(k in mp)),
    pagesChanged: keys(mp).filter((k) => k in cp && !same(cp[k], mp[k])),
    patternsBefore: (current.patterns || []).length,
    patternsAfter: (merged.patterns || []).length,
    patternsChanged: (current.patterns || []).length === (merged.patterns || []).length && !same(current.patterns, merged.patterns),
    otherTopLevelChanged: keys(merged).filter((k) => !['pages', 'patterns', '_rev'].includes(k) && !same(current[k], merged[k])),
    baseRevAtProposal: base._rev, currentRev: current._rev,
  };
  summary.noop = !summary.pagesAdded.length && !summary.pagesRemoved.length && !summary.pagesChanged.length
    && summary.patternsBefore === summary.patternsAfter && !summary.patternsChanged && !summary.otherTopLevelChanged.length;
  return { merged, conflicts, summary };
}

export function checkGuards({ site, proposalName, engineDeployed }) {
  if (!ALLOWED_SITES.has(site)) return `site ${site} is not allowed: this proposal covers only sites ${[...ALLOWED_SITES].join(' and ')}`;
  if (/phase2/i.test(proposalName) && !engineDeployed) return 'phase 2 needs the engine change deployed first: pass --engine-deployed once it is live';
  if (site === 1 && !/^zunkiree-1-/.test(proposalName)) return 'this proposal does not belong to site 1';
  if (site === 8862 && !/^admizz-8862-/.test(proposalName)) return 'this proposal does not belong to site 8862';
  return null;
}

function loadJson(f) { return JSON.parse(fs.readFileSync(path.join(PROPOSAL_DIR, f), 'utf8')); }

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
  const site = Number(flag('site')); const proposalName = flag('proposal');
  if (!site || typeof proposalName !== 'string') { console.error('Usage: apply-url-file-map-proposal.js --site <1|8862> --proposal <file in proposals/> [--engine-deployed] [--apply]'); process.exit(1); }
  const guard = checkGuards({ site, proposalName, engineDeployed: flag('engine-deployed') === true });
  if (guard) { console.error('Refused: ' + guard); process.exit(1); }
  const base = loadJson(`base-${site}.json`); const proposed = loadJson(proposalName);
  const { pool, patchUrlFileMap, query } = await import('../db.js');
  try {
    const current = (await query('SELECT url_file_map FROM sites WHERE id = $1', [site])).rows[0]?.url_file_map;
    if (!current) throw new Error(`No site ${site}`);
    const { conflicts, summary } = planProposal(base, current, proposed);
    console.log(JSON.stringify({ site, proposal: proposalName, ...summary, conflicts }, null, 2));
    if (conflicts.length) { console.error('\nCONFLICTS: someone changed the same keys differently since this proposal was written. Nothing written. Regenerate the proposal.'); process.exitCode = 2; return; }
    if (summary.noop) { console.log('\nNothing to do: the map already matches the proposal.'); return; }
    if (flag('apply') !== true) { console.log('\nDRY RUN: nothing written. Re-run with --apply to write.'); return; }
    const res = await patchUrlFileMap(site, (cur) => {
      const plan = planProposal(base, cur, proposed);
      if (plan.conflicts.length) throw new Error('conflict while applying: ' + plan.conflicts.join(', '));
      return plan.summary.noop ? null : plan.merged;
    });
    console.log(res.changed ? `\nAPPLIED to site ${site}.` : '\nNo change needed.');
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e.message); process.exit(1); });
