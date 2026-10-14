import { resolvePageRole, layoutRoleFromContract } from './page-role.js';
import { getDesignProfile } from './design-drift.js';
import { assessDesignCompleteness, designGateMode, describeBlocks } from '../../design-agent/lib/design-completeness.js';
import {
  pickReferencePage, renderableBody, checkNewPageRender, renderGateVerdict, isRenderGateEnabled,
} from '../../generators/lib/newpage-render-gate.js';
import { recordGateDecision, setDraftRenderGate } from '../../store/design-gate-decisions.js';
import { classifyPageType } from '../../design-agent/live-analysis/schema.js';
import { pageFamilyOf } from '../../design-agent/lib/design-knowledge.js';

// The pre-ship design gates for net-new whole pages, in one place so the
// policy can be tested without a repo, a browser or a database.
//
//   1. completeness — does the site's captured design cover what this page
//      renders? (design-completeness.js; gaps derived from the site first.)
//   2. render — rendered into a real page of the same role, does the draft
//      MEASURE like the site? (newpage-render-gate.js; needs a browser, so it
//      has its own switch, NEWPAGE_RENDER_GATE_ENABLED.)
//
// Mode (designGateMode): 'off' runs nothing. 'log' runs both, records what
// WOULD have been held, and ships. 'enforce' holds. Every decision is recorded
// in both modes, so the log-only week produces the table that says whether
// enforcing would take a site's output to zero.

const frontMatterValue = (body, key) => {
  const m = String(body || '').match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
};

const DEFAULT_DEPS = {
  record: recordGateDecision,
  storeRenderGate: setDraftRenderGate,
  checkRender: checkNewPageRender,
  deriveContract: null,
  notify: null,
  // The learning half. Lazy defaults so this module stays DB-free to import.
  learnFailure: async (...a) => (await import('../../store/design-knowledge.js')).recordDesignFailure(...a),
  learnFix: async (...a) => (await import('../../store/design-knowledge.js')).recordDesignFix(...a),
  hadRecentBlock: async (siteId, actionType) => {
    const { query } = await import('../../db.js');
    const { rows } = await query(
      `SELECT 1 FROM design_gate_decisions
        WHERE site_id = $1 AND action_type = $2 AND blocked AND created_at > now() - interval '30 days' LIMIT 1`,
      [siteId, actionType],
    );
    return rows.length > 0;
  },
  requeueProfile: async (...a) => (await import('../../design-agent/lib/design-block-repair.js')).requeueProfileForRepeatedBlocks(...a),
};

// Tell the owner ONCE per episode, only when a draft was really held. Log mode
// never notifies: nothing was held, and the log table is the record.
async function announce(d, site, held) {
  const notify = d.notify || (async (...a) => (await import('../../notifications/design-blocked.js')).notifyDesignBlocked(...a));
  await notify(site, held).catch(() => {});
  return held;
}

export async function runDesignGates(site, draft, resolved, deps = {}) {
  const mode = designGateMode();
  if (mode === 'off') return { ok: true, skipped: 'off' };
  const d = { ...DEFAULT_DEPS, ...deps };
  const enforce = mode === 'enforce';
  const actionType = draft.action_type;
  const permalink = frontMatterValue(resolved?.body, 'permalink');

  // Tier B of the role resolver — what the directory's own human-written
  // posts declare. Best effort and cached per directory; an unreadable repo is
  // simply no evidence.
  let layoutRole = null;
  if (d.deriveContract) {
    layoutRole = layoutRoleFromContract(await d.deriveContract(site, actionType).catch(() => null));
  }
  const role = resolvePageRole(site, { permalink, actionType, layoutRole });
  const profile = getDesignProfile(site);

  // --- 1. completeness
  const assessment = assessDesignCompleteness(profile, {
    actionType, pageRole: role.role, inlineProse: site?.url_file_map?.siteRoot?.inlineProse || null,
  });
  await d.record(site.id, {
    draftId: draft.id ?? null, actionType, gate: 'completeness', mode, blocked: !assessment.ok,
    reason: assessment.ok ? assessment.tier : assessment.blocks[0]?.reason,
    detail: { tier: assessment.tier, blocks: assessment.blocks, derived: assessment.derived, role, repairable: Boolean(assessment.repairable) },
  });
  const family = permalink ? pageFamilyOf(permalink) : null;
  if (!assessment.ok) {
    // A block is knowledge either way. Kept as an anti-pattern for this
    // tenant's page family, and a gap the Design Agent can fill sends it back
    // to the live site once it keeps happening.
    await d.learnFailure(site.id, {
      patternId: 'design-incomplete', pageUrl: permalink, detail: describeBlocks(assessment),
      correction: `Generating a "${role.role}" page while the captured design lacked: ${assessment.blocks.map((b) => `${b.field}: ${b.reason}`).join(', ')}`,
      draftId: draft.id ?? null, validation: { passed: false, gate: 'completeness', mode },
    }).catch(() => {});
    if (assessment.repairable) await d.requeueProfile(site).catch(() => {});
  }
  if (!assessment.ok && enforce) {
    await announce(d, site, { reason: 'design-incomplete', actionType });
    return {
      ok: false, reason: 'design-incomplete',
      error: `This site's captured design does not cover what this page renders — ${describeBlocks(assessment)}. Held rather than shipped: matching the site is not optional.`,
      designAssessment: assessment,
    };
  }

  // --- 2. render comparison
  if (!isRenderGateEnabled() || !assessment.artifacts?.length) return { ok: true, role, assessment };
  const body = renderableBody(resolved?.body, resolved?.contentFormat);
  if (body.skip) {
    await d.record(site.id, { draftId: draft.id ?? null, actionType, gate: 'render', mode, blocked: false, reason: body.reason, detail: { role } });
    return { ok: true, role, assessment };
  }

  const refPageType = permalink ? classifyPageType(`https://x.invalid${permalink.startsWith('/') ? '' : '/'}${permalink}`, { propertyType: site?.property_type }) : null;
  const referenceUrl = pickReferencePage(profile, role.role, permalink, { pageType: refPageType });
  const result = referenceUrl ? await d.checkRender({ referenceUrl, newPageHtml: body.html }) : null;
  const verdict = renderGateVerdict(result, { roleConfidence: role.confidence, hasReference: Boolean(referenceUrl) });

  const renderGate = { ...verdict, mode, role, referenceUrl, checkedAt: new Date().toISOString() };
  await d.record(site.id, { draftId: draft.id ?? null, actionType, gate: 'render', mode, blocked: verdict.blocked, reason: verdict.reason, detail: { ...(verdict.detail || {}), role, referenceUrl } });
  if (verdict.blocked) await d.storeRenderGate(draft.id, renderGate);
  // Only a MEASURED deviation is knowledge about the design. "No reference page"
  // and "could not verify" are about the check, not about how this site looks.
  if (verdict.reason === 'render-deviation') {
    const deviations = verdict.detail?.deviations || [];
    await d.learnFailure(site.id, {
      patternId: 'render-deviation', pageUrl: permalink, pageType: refPageType,
      detail: deviations.map((v) => `${v.kind} ${v.expected} -> ${v.actual} (${v.viewport})`).join('; '),
      correction: `Draft body rendered with ${deviations.map((v) => v.kind).join(', ')} off the reference page's values`,
      draftId: draft.id ?? null, validation: { passed: false, gate: 'render', mode },
    }).catch(() => {});
  } else if (verdict.reason === 'matches' && await d.hadRecentBlock(site.id, actionType).catch(() => false)) {
    // Held before, passes now: whatever changed (usually a re-derived profile)
    // is validated knowledge for this page family.
    await d.learnFix(site.id, {
      patternId: 'render-deviation', pageUrl: permalink, pageType: refPageType,
      detail: 'A page of this kind that was previously held now renders like the site\'s own reference page.',
      correction: 'Passed after an earlier hold — the captured design or the draft changed in between (the cause is not isolated).',
      draftId: draft.id ?? null, validation: { passed: true, gate: 'render', mode },
    }).catch(() => {});
  }

  if (verdict.blocked && enforce) {
    const what = verdict.reason === 'render-deviation'
      ? `Rendered into a real "${role.role}" page on this site it measures differently: ${verdict.detail.deviations.map((v) => `${v.kind} ${v.expected} → ${v.actual} (${v.viewport})`).join('; ')}.`
      : verdict.reason === 'no-reference-page'
        ? `No real "${role.role}" page on this site could be found to compare it against, so it needs a person to look at it.`
        : `It could not be verified (${verdict.reason}).`;
    const heldReason = verdict.reason === 'no-reference-page' ? 'needs-human-review' : verdict.reason;
    await announce(d, site, { reason: heldReason, actionType });
    return { ok: false, reason: heldReason, error: `${what} Held rather than shipped.`, renderGate };
  }
  return { ok: true, role, assessment, renderGate };
}
