import { pool, updateSiteRepoConfig } from '../db.js';

// Sets url_file_map.approvers (GitHub logins whose "ok" / approving review lets the agent merge its own PR into STAGE — see
// lib/approval-merge.js). DRY RUN BY DEFAULT: prints exactly what would change and writes nothing. Pass --apply to write.
// Review-first sites (Mobilise) and sites with no repo are always skipped: their approval stays a person pressing the button.
//
//   node server/scripts/set-site-approvers.js --approvers yukta-commits [--site-ids 1,8862] [--apply]

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };
const approvers = (arg('approvers') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!approvers.length) { console.error('usage: --approvers login[,login] [--site-ids 1,2] [--apply]'); process.exit(2); }
const only = (arg('site-ids') || '').split(',').map(Number).filter(Boolean);
const apply = process.argv.includes('--apply');

const { rows } = await pool.query(`SELECT id, name, ship_mode, repo_owner, repo_name, url_file_map FROM sites WHERE deleted_at IS NULL AND status = 'active' ORDER BY id`);
for (const s of rows) {
  if (only.length && !only.includes(s.id)) continue;
  const skip = s.ship_mode === 'review-first' ? 'review-first (approved by hand)' : (!s.repo_owner || !s.repo_name) ? 'no repo connected' : null;
  if (skip) { console.log(`#${s.id} ${s.name}: SKIP — ${skip}`); continue; }
  const before = s.url_file_map?.approvers || null;
  const next = [...new Set([...(before || []), ...approvers])];
  if (JSON.stringify(before) === JSON.stringify(next)) { console.log(`#${s.id} ${s.name}: already ${JSON.stringify(next)}`); continue; }
  console.log(`#${s.id} ${s.name}: approvers ${JSON.stringify(before)} -> ${JSON.stringify(next)}${apply ? '  [WRITING]' : '  [dry run]'}`);
  if (apply) await updateSiteRepoConfig({ siteId: s.id, urlFileMap: { ...(s.url_file_map || {}), approvers: next } });
}
await pool.end();
console.log(apply ? 'Applied.' : 'Dry run only — nothing was written. Re-run with --apply to write.');
