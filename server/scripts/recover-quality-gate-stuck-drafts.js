import 'dotenv/config';
import { pool, query } from '../db.js';
import { deleteDraft } from '../store/drafts.js';

// One-off recovery for drafts stuck permanently by the duplicate-paragraph
// false positive fixed in generators/lib/duplicate-content-guard.js
// (2026-08-25): meta-title.js's `titles[]` (alternative candidates for the
// same query) and open-graph.js's `twitterTitle`/`twitterDescription`
// (a deterministic mirror of ogTitle/ogDescription) both got flagged as an
// LLM "repeating itself," so approveAndPublishDraft's Quality Gate re-check
// threw a 422 on every attempt. auto-remediation.js's shipDraftForRecommendation
// catches that error but never reverts the draft row, so it's left forever at
// status='submitted_for_approval' with no branch/PR — and because a
// non-abandoned draft now exists for that finding_id, getDraftedFindingIds()
// hides the underlying recommendation from the Action Center and from the
// next auto-remediation pass too, even though recommendations.status is
// still 'open' in the DB. Deleting the stuck draft (the same DELETE
// /action-center/drafts/:id path a human "Discard Draft" click already
// hits) is what un-hides the recommendation — no separate "reset the
// recommendation" step exists or is needed, since its status was never
// touched.
//
//   node server/scripts/recover-quality-gate-stuck-drafts.js                  (dry run, all sites)
//   node server/scripts/recover-quality-gate-stuck-drafts.js --site-id <id>   (dry run, one site)
//   node server/scripts/recover-quality-gate-stuck-drafts.js --apply          (actually delete)

const AFFECTED_GENERATOR_IDS = ['meta-title', 'open-graph'];

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

async function findStuckDrafts(siteId) {
  const conditions = [
    `status = 'submitted_for_approval'`,
    `action_type = ANY($1)`,
    `validation_status IS NOT NULL`,
    `EXISTS (
      SELECT 1 FROM jsonb_array_elements(validation_status -> 'qualityGate' -> 'issues') AS issue
      WHERE issue ->> 'patternId' = 'duplicate-paragraph'
    )`,
  ];
  const values = [AFFECTED_GENERATOR_IDS];
  if (siteId) { values.push(siteId); conditions.push(`site_id = $${values.length}`); }
  const { rows } = await query(
    `SELECT id, site_id, action_type, source, finding_id, created_at,
            validation_status -> 'qualityGate' -> 'issues' AS quality_gate_issues
     FROM drafts
     WHERE ${conditions.join(' AND ')}
     ORDER BY site_id, created_at DESC`,
    values,
  );
  return rows;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const siteId = flags['site-id'] ? Number(flags['site-id']) : null;
  const apply = !!flags.apply;

  const stuck = await findStuckDrafts(siteId);
  console.log(`Found ${stuck.length} stuck draft(s)${siteId ? ` for site #${siteId}` : ' across all sites'}.\n`);
  console.log(`Mode: ${apply ? 'APPLY (will delete these drafts)' : 'DRY RUN (pass --apply to actually delete)'}\n`);

  for (const d of stuck) {
    console.log(`- draft #${d.id} (site #${d.site_id}, ${d.action_type}, finding ${d.finding_id}, created ${d.created_at.toISOString()})`);
    console.log(`  issues: ${JSON.stringify(d.quality_gate_issues)}`);
  }

  if (!apply || stuck.length === 0) return;

  let deleted = 0;
  for (const d of stuck) {
    const ok = await deleteDraft(d.site_id, d.id);
    if (ok) deleted++;
    else console.log(`  ! draft #${d.id} was not deleted (already implemented or gone)`);
  }
  console.log(`\nDeleted ${deleted}/${stuck.length} draft(s). Their recommendations will reappear in the Action Center immediately.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
