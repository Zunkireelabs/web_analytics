// SHIP: the ONE consolidated run (11:00 Asia/Kathmandu). It takes ONLY items the prepare stage marked prepared, pushes them as one
// batch commit and opens ONE pull request per project. It never merges: a person merges on GitHub.
//
// Why unprepared work can never ship, three times over:
//   1. it lists only state = 'prepared';
//   2. claimForShipping's own UPDATE ... WHERE state = 'prepared' moves only prepared rows, atomically, so a row that changed in the
//      meantime (or a second process) is simply not returned;
//   3. approveAndPublishDraftUnattended re-runs every validation check on the draft right before it is pushed.
// A second ship run the same day finds nothing to claim (the rows are 'shipping' / 'shipped'): no duplicate push, no second PR.
//
// FAILURE / RECOVERY. A draft refused at push time fails its item (non-retryable) or goes back to 'prepared' if the failure was an
// outage. If the pull request cannot be opened, nothing is marked shipped: the pushed drafts are abandoned (their recommendations
// become visible again) and their items fail, so the next cycle prepares them afresh instead of re-shipping half-finished work.

import { isOutage } from './prepare.js';
import { minutesOf } from './config.js';

export async function shipPreparedForSite(site, deps, { now = new Date() } = {}) {
  const { listByState, claimForShipping, beginBatchPush, batchBranchName, approveAndPublishDraftUnattended, finalizeBatchPr, markShipped, releaseItem, abandonDraft } = deps;
  // Only draft-backed items: content/template-repair file edits are also 'prepared' but have no draft and keep their own drain.
  const prepared = (await listByState(site.id, 'prepared')).filter((i) => (i.kind ?? 'draft') === 'draft' && i.draft_id);
  if (!prepared.length) return { siteId: site.id, claimed: 0, pushed: 0, shipped: 0, pr: null };

  const batchId = `ship-${site.id}-${now.toISOString()}`;
  const claimed = await claimForShipping(site.id, prepared.map((i) => i.id), batchId);
  if (!claimed.length) return { siteId: site.id, claimed: 0, pushed: 0, shipped: 0, pr: null };

  const branch = batchBranchName(site, now);
  beginBatchPush(site, branch);
  const pushed = [];
  for (const item of claimed) {
    try {
      const d = await approveAndPublishDraftUnattended(site.id, item.draft_id, { deferPr: true });
      if (d?.status === 'branch_pushed') pushed.push({ item, draftId: d.id });
      else await releaseItem(item.id, { retryable: false, error: `not pushed (draft status ${d?.status ?? 'unknown'})` });
    } catch (err) {
      await releaseItem(item.id, { retryable: isOutage(err), error: String(err.message || err).slice(0, 500) });
    }
  }
  if (!pushed.length) return { siteId: site.id, claimed: claimed.length, pushed: 0, shipped: 0, pr: null };

  let pr = null;
  try {
    pr = await finalizeBatchPr(site, branch, pushed.map((p) => p.draftId));
  } catch (err) {
    pr = { ok: false, error: String(err.message || err) };
  }
  if (!pr?.ok) {
    for (const p of pushed) {
      await abandonDraft(site.id, p.draftId, `pull request could not be opened: ${pr?.error ?? 'unknown'}`).catch(() => {});
      await releaseItem(p.item.id, { retryable: false, error: `pull request not opened: ${pr?.error ?? 'unknown'}` });
    }
    return { siteId: site.id, claimed: claimed.length, pushed: pushed.length, shipped: 0, pr: null, error: pr?.error };
  }
  for (const p of pushed) await markShipped(p.item.id);
  return { siteId: site.id, claimed: claimed.length, pushed: pushed.length, shipped: pushed.length, pr: { number: pr.prNumber ?? null, url: pr.prUrl ?? null } };
}

// THE 11:00 GUARD. The consolidated ship run refuses to start before its time (in Asia/Kathmandu) or with prepared-only shipping
// switched off, so no earlier trigger (a catch-up, a stray dev process) can ship the day's work before preparation has had its
// window. Returns why it did not run, or the per-project results.
export async function shipPreparedForAllSites({ sites, deps, config, now = new Date(), localMinutes }) {
  if (!config.shipPreparedOnly) return { skipped: 'prepared-only shipping is switched off (SHIP_PREPARED_ONLY)' };
  const shipAt = minutesOf(config.shipAt || '11:00');
  if (localMinutes(now) < shipAt) return { skipped: `before ${config.shipAt || '11:00'} ${config.timezone}` };
  const results = [];
  for (const site of sites) {
    try { results.push(await shipPreparedForSite(site, deps, { now })); } catch (err) { results.push({ siteId: site.id, error: String(err.message || err) }); }
  }
  return { results };
}
