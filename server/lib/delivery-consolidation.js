// PHASE 4: THE DEADLINE STEP. Before the working day ends, every project's validated work is brought to ONE pull request on its own batch branch, and if the PR
// cannot be opened the work is PRESERVED as a complete, actionable delivery record, never left as a silent failure.
//
// What already exists and is reused (not duplicated): batches are one branch per project per day (`action-center/batch-<site>-<day>`), finalizeBatchPr opens
// ONE PR at the end of a pass, and lib/batch-pr-recovery.js finishes a batch whose commits landed but whose PR did not. What was missing is a step that
// RUNS BY THE DEADLINE for every project independently, and a durable record of exactly what is stuck and how to finish it.
//
// SAFETY, learned from reading batch-pr-recovery.js: it abandons a draft whose commit is not on the branch yet, and a pass that is still running looks exactly
// like that. So this step NEVER touches a project whose shipping lock is held (a pass is in flight); it reports "deferred" and is run again (the day close
// calls it again, and the in-flight pass opens its own PR when it ends). It opens pull requests only; it never merges, never creates branches, never writes files.
import { query as defaultQuery } from '../db.js';
import { batchBranchFor, cycleDateIn } from './delivery-cycle.js';
import { operatorDetail } from './errors.js';

/** Pure. The one record that says what is stuck and how to finish it by hand. Everything a person needs, nothing they have to go looking for. */
export function buildPreservedDelivery({ site, branch, drafts = [], headSha = null, commitSubjects = null, exactError = null, now = new Date() }) {
  const repo = site.repo_owner && site.repo_name ? `${site.repo_owner}/${site.repo_name}` : null;
  const base = site.pr_target_branch || site.repo_default_branch || 'main';
  const items = drafts.map((d) => ({
    draftId: d.id, actionType: d.action_type || null, findingId: d.finding_id || null,
    validation: d.validation_status || null, error: d.apply_error ? String(d.apply_error).slice(0, 300) : null,
  }));
  const errors = items.map((i) => i.error).filter(Boolean);
  const reason = exactError || errors[0] || 'The pull request could not be opened; GitHub gave no further detail.';
  const rateLimited = /rate limit/i.test(reason);
  return {
    preservedAt: new Date(now).toISOString(),
    site: { id: site.id, name: site.name || null, repo },
    branch, base, headSha, commitSubjects,
    itemCount: items.length, items,
    exactError: String(reason).slice(0, 500),
    cause: rateLimited ? 'github-rate-limit' : 'pr-open-failed',
    recovery: {
      automatic: 'The hourly reconciler (pass 0) retries opening this pull request on its own once the GitHub budget allows.',
      byHand: repo ? [
        `gh pr create --repo ${repo} --base ${base} --head ${branch} --title "SuperRank: ${items.length} change(s) for ${site.name || repo}"`,
        `or open the Action Center and use "Retry PR" on draft #${items[0]?.draftId ?? '?'}`,
      ] : ['Open the Action Center and use "Retry PR" on the first draft listed.'],
      nothingLost: 'Every change is committed on the branch and stored on its draft; nothing needs regenerating.',
    },
  };
}

/** Pure. The preserved delivery as the readable text a person gets in the status view or an email. */
export function renderPreservedDeliveryMarkdown(d) {
  if (!d) return '';
  const lines = [
    `## Preserved delivery: ${d.site?.name || `site ${d.site?.id}`}`,
    '',
    `The work is safe on branch \`${d.branch}\`${d.headSha ? ` (head \`${String(d.headSha).slice(0, 10)}\`)` : ''}, but its pull request was not opened.`,
    '',
    `**Exact reason:** ${d.exactError}`,
    '',
    `**What is on the branch (${d.itemCount}):**`,
    ...d.items.map((i) => `- draft #${i.draftId} ${i.actionType || ''}${i.validation ? ` (validation: ${i.validation})` : ''}${i.error ? ` — ${i.error}` : ''}`),
    '',
    '**How to finish:**',
    `- ${d.recovery.automatic}`,
    ...d.recovery.byHand.map((c) => `- ${c}`),
    `- ${d.recovery.nothingLost}`,
  ];
  return lines.join('\n');
}

const PENDING_SQL = `SELECT id, action_type, finding_id, apply_error, validation_status FROM drafts
   WHERE site_id = $1 AND status = 'branch_pushed' AND pr_number IS NULL AND branch_name = $2 ORDER BY id`;
const OPENED_SQL = `SELECT pr_url FROM drafts WHERE site_id = $1 AND pr_url IS NOT NULL AND pr_number IS NOT NULL AND branch_name = $2 LIMIT 1`;

/**
 * Brings each project's work for TODAY to a pull request, independently. A failure in one project never stops the others.
 *   dryRun        true = report only (see DELIVERY_CONSOLIDATION_MODE)
 *   timezone      the worker's time zone (the day record's key)
 *   sites         active projects (rows with id, timezone, repo_owner, repo_name, ...)
 *   isLocked(site)           true while a shipping pass holds the project's lock: that project is deferred, never touched
 *   recover(siteId)          the PR recovery (batch-pr-recovery.recoverUnopenedBatchPrs wired with openDraftPr); injected so tests need no GitHub
 *   describeBranch(site, branch) -> { headSha, commitSubjects }   best-effort GitHub read for the preserved record
 * @returns one result per project: { siteId, outcome: 'nothing-to-open' | 'delivered' | 'preserved' | 'deferred' | 'error', ... }
 */
export async function consolidateDay({ sites, now = new Date(), timezone = 'Asia/Kathmandu', query = defaultQuery, isLocked = async () => false, recover, describeBranch = async () => ({}), log = console.log, dryRun = false } = {}) {
  if (typeof recover !== 'function') throw new Error('consolidateDay requires a recover implementation');
  const out = [];
  for (const site of sites) {
    try {
      const branch = batchBranchFor(site, now);
      if (await isLocked(site)) { out.push({ siteId: site.id, outcome: 'deferred', why: 'a shipping pass is running for this project; its own batch opens the PR when it ends', branch }); continue; }
      let { rows: pending } = await query(PENDING_SQL, [site.id, branch]);
      if (pending.length === 0) {
        const { rows: opened } = await query(OPENED_SQL, [site.id, branch]);
        out.push({ siteId: site.id, outcome: opened[0] ? 'delivered' : 'nothing-to-open', branch, prUrl: opened[0]?.pr_url || null });
        continue;
      }
      // dryRun (DELIVERY_CONSOLIDATION_MODE=log): say what WOULD happen and touch nothing: no pull request is opened, nothing is written to the day record.
      if (dryRun) { out.push({ siteId: site.id, outcome: 'would-open', branch, pending: pending.length }); continue; }
      let recoverError = null;
      try { await recover(site.id); } catch (err) { recoverError = err; }
      ({ rows: pending } = await query(PENDING_SQL, [site.id, branch]));
      if (pending.length === 0) {
        const { rows: opened } = await query(OPENED_SQL, [site.id, branch]);
        out.push({ siteId: site.id, outcome: opened[0] ? 'delivered' : 'nothing-to-open', branch, prUrl: opened[0]?.pr_url || null });
        log?.(`[delivery-consolidation] site ${site.id}: opened the pull request for ${branch}`);
        continue;
      }
      const info = await describeBranch(site, branch).catch(() => ({}));
      const delivery = buildPreservedDelivery({ site, branch, drafts: pending, headSha: info.headSha || null, commitSubjects: info.commitSubjects || null, exactError: recoverError ? (recoverError.message || String(recoverError)) : null, now });
      await persistPreservedDelivery(site, delivery, { now, timezone, query });
      log?.(`[delivery-consolidation] site ${site.id}: PR not opened; ${delivery.itemCount} change(s) preserved on ${branch} (${delivery.cause})`);
      out.push({ siteId: site.id, outcome: 'preserved', branch, delivery });
    } catch (err) {
      log?.(`[delivery-consolidation] site ${site.id} failed: ${operatorDetail(err)}`);
      out.push({ siteId: site.id, outcome: 'error', error: err.message });
    }
  }
  return out;
}

/** Writes the preserved delivery onto the project's day record, where the day close and the status view read it. */
export async function persistPreservedDelivery(site, delivery, { now = new Date(), timezone = 'Asia/Kathmandu', query = defaultQuery } = {}) {
  const day = cycleDateIn(timezone, now); // the day record is keyed by the WORKER's day (the 5 PM deadline is a Nepal clock), like every delivery_cycles row
  await query(
    `INSERT INTO delivery_cycles (site_id, cycle_date) VALUES ($1, $2) ON CONFLICT (site_id, cycle_date) DO NOTHING`, [site.id, day]);
  await query(
    `UPDATE delivery_cycles SET branch_name = $3, head_sha = COALESCE($4, head_sha), stages = jsonb_set(stages, '{delivery}', $5::jsonb, true), updated_at = now()
      WHERE site_id = $1 AND cycle_date = $2`,
    [site.id, day, delivery.branch, delivery.headSha, JSON.stringify(delivery)]);
}
