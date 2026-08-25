import 'dotenv/config';
import { pool, query } from '../db.js';
import { markDraftAbandoned } from '../store/drafts.js';

// One-off recovery for drafts stranded by the swallow-and-strand gap fixed
// in routes/action-center.js (2026-08-25): approveAndPublishDraft can throw
// AFTER a draft is already durably 'submitted_for_approval' (a render-mode
// rejection, a failed implementer preview, a rendering-gate refusal), and
// the two unattended auto-ship callers (auto-remediation.js's
// shipDraftForRecommendation, this file's own shipRecommendation) caught
// that error and logged it but never reverted the row. getDraftedFindingIds()
// then treated the row as "already handled" forever, permanently hiding the
// underlying recommendation. approveAndPublishDraftUnattended now abandons
// the draft on failure going forward — this script applies the same
// recovery to the 31 real rows already stuck this way before the fix
// shipped, via the same markDraftAbandoned path DraftModal.jsx's own
// "Discard"/"Reject" actions already use, which is what makes
// getDraftedFindingIds() stop counting them and the recommendation reappear.
//
//   node server/scripts/recover-stranded-unattended-drafts.js                  (dry run, all sites)
//   node server/scripts/recover-stranded-unattended-drafts.js --site-id <id>   (dry run, one site)
//   node server/scripts/recover-stranded-unattended-drafts.js --apply          (actually abandon)

const UNATTENDED_SOURCES = ['auto-remediation', 'execution-engine'];

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

async function findStrandedDrafts(siteId) {
  const conditions = [
    `status = 'submitted_for_approval'`,
    `source = ANY($1)`,
    `apply_error IS NULL`,
  ];
  const values = [UNATTENDED_SOURCES];
  if (siteId) { values.push(siteId); conditions.push(`site_id = $${values.length}`); }
  const { rows } = await query(
    `SELECT id, site_id, action_type, source, finding_id, created_at
     FROM drafts
     WHERE ${conditions.join(' AND ')}
     ORDER BY site_id, created_at ASC`,
    values,
  );
  return rows;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = flags['site-id'] ? Number(flags['site-id']) : null;
  const apply = !!flags.apply;

  const stranded = await findStrandedDrafts(siteId);
  console.log(`Found ${stranded.length} stranded draft(s)${siteId ? ` for site #${siteId}` : ' across all sites'}.\n`);
  console.log(`Mode: ${apply ? 'APPLY (will abandon these drafts)' : 'DRY RUN (pass --apply to actually abandon)'}\n`);

  for (const d of stranded) {
    console.log(`- draft #${d.id} (site #${d.site_id}, ${d.action_type}, source ${d.source}, finding ${d.finding_id}, created ${d.created_at.toISOString()})`);
  }

  if (!apply || stranded.length === 0) return;

  let abandoned = 0;
  for (const d of stranded) {
    const ok = await markDraftAbandoned(d.site_id, d.id, 'Recovered: stranded at submitted_for_approval by the pre-fix swallow-and-strand gap in the unattended auto-ship path (2026-08-25).', null);
    if (ok) abandoned++;
    else console.log(`  ! draft #${d.id} was not abandoned (already implemented/abandoned, or gone)`);
  }
  console.log(`\nAbandoned ${abandoned}/${stranded.length} draft(s). Their recommendations will reappear in the Action Center immediately.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
