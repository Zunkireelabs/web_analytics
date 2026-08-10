import { listOpenRecommendations } from '../../store/recommendations.js';
import { getDraftedFindingIds, submitDraftForApproval, updateDraft } from '../../store/drafts.js';
import { getSiteById } from '../../store/read.js';
import { generateDraft, approveAndPublishDraft, autoSelectMetaTitle } from '../../routes/action-center.js';

// Stage 3-4 of Generate -> Validate -> Auto-fix -> Validate again -> Action
// Center: closes the loop risk-tiers.js opened. A 'safe'-tier recommendation
// doesn't need a human to click anything — generateDraft() already runs the
// Quality Gate (generators/lib/quality-gate.js) with a bounded regeneration
// attempt, and approveAndPublishDraft() re-validates before the PR opens, so
// this function is deliberately thin: draft it, submit it, publish it, and
// let those two gates be the only thing standing between a detected issue
// and a real PR. On a Quality Gate rejection (or any other failure) the
// recommendation is simply left open — getRecommendations() only hides a
// recommendation once a draft actually exists for it, so an issue this
// couldn't safely auto-fix surfaces in the Action Center exactly like any
// other issue that "genuinely requires human judgment."
//
// Called after syncFromGrounded() from both server/job.js's daily cron and
// routes/action-center.js's refreshRecommendations() — the same two places
// that already create/refresh recommendation rows — so every path that can
// detect a safe-tier issue also gets a chance to auto-remediate it, not just
// one of them.
//
// Opt-in per site (sites.auto_remediation_enabled, migration 089) — see that
// migration's comment for why this isn't on by default.
export async function autoRemediateSafeRecommendations(siteId) {
  const site = await getSiteById(siteId);
  if (!site?.auto_remediation_enabled) return { attempted: 0, shipped: 0, failed: 0 };

  const [rows, draftedFindingIds] = await Promise.all([
    listOpenRecommendations(siteId),
    getDraftedFindingIds(siteId),
  ]);
  const candidates = rows.filter((r) => r.risk_tier === 'safe' && r.finding_ids.every((fid) => !draftedFindingIds.has(fid)));

  let shipped = 0;
  let failed = 0;
  for (const rec of candidates) {
    try {
      const draft = await generateDraft(siteId, {
        generatorId: rec.recommendation_type, params: rec.params, source: 'auto-remediation', findingId: rec.finding_ids[0],
      });

      const autoSelected = autoSelectMetaTitle(rec.recommendation_type, draft.content);
      if (autoSelected) {
        const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
        if (updated) draft.content = updated.content;
      }

      const submitted = await submitDraftForApproval(siteId, draft.id);
      if (!submitted) throw new Error('Draft was not in a submittable state');

      const approved = await approveAndPublishDraft(siteId, draft.id, { userId: null });
      if (!approved.branch_name) throw new Error(approved.apply_error || 'Approved but no branch was pushed');
      shipped++;
    } catch (err) {
      failed++;
      console.warn(`[auto-remediation] site ${siteId} could not auto-fix recommendation ${rec.id} (${rec.recommendation_type}), leaving it open:`, err.message);
    }
  }
  return { attempted: candidates.length, shipped, failed };
}
