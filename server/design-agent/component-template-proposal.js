import {
  validatePlaceholders, checkTemplateFreshness, COMPONENT_TEMPLATE_KEY, templateActionRequiresRow, recordRejectedTemplateLesson,
} from '../implementers/lib/design-drift.js';

// Shapes one Design Agent-derived {wrapper, row} template (keyed by the
// same design-drift.js/marker-merge.js action-type strings, e.g. 'faq',
// 'expand-content') into the same {stale, missingClasses, proposedTemplate}
// contract routes/clients.js's existing /regenerate route already returns
// for the non-Design-Agent (proposeUpdatedTemplate) path — one consistent
// proposal shape regardless of which mechanism produced it, and it lands in
// the exact same human-reviewed /confirm route either way.
//
// Design Agent's real-repo grounding is additional confidence, not a reason
// to skip the gate every other proposal already goes through:
// validatePlaceholders (structural — are the required tokens present) always
// runs and can hard-reject; checkTemplateFreshness (are the claimed classes
// real, checked against a live page's actual current CSS) runs only when a
// pageUrl is available, and surfaces as `missingClasses` rather than a hard
// rejection — same fail-open discipline design-drift.js itself already uses
// for infra failures, since the human /confirm step is still the real gate
// before anything is saved to url_file_map.
export async function buildComponentTemplateProposal({
  actionType, template, pageUrl, siteId = null, checkTemplateFreshnessFn = checkTemplateFreshness, recordFixOutcomeFn,
}) {
  if (!COMPONENT_TEMPLATE_KEY[actionType]) {
    return { ok: false, error: `"${actionType}" has no component-template concept — only ${Object.keys(COMPONENT_TEMPLATE_KEY).join(', ')} do.` };
  }
  if (!template?.wrapper || (templateActionRequiresRow(actionType) && !template?.row)) {
    return { ok: false, error: 'Design Agent did not report a template for this action type.' };
  }

  const placeholderCheck = validatePlaceholders(actionType, template);
  if (!placeholderCheck.ok) {
    // Same LEARN write the autonomous path (design-drift.js's
    // resolveOrCreateComponentTemplate) uses on the identical rejection —
    // one shared write path, not a fork, so a lesson recorded from a staff
    // member reviewing this proposal is available to the autonomous path's
    // next RETRIEVE, and vice versa. This proposal function is reached from
    // the staff-triggered /design-generate + /confirm inspection route
    // (routes/clients.js), never a required step for a draft to ship — see
    // resolveOrCreateComponentTemplate, the sole autonomous entry point
    // wired into generateDraft.
    recordRejectedTemplateLesson({ siteId, actionType, error: placeholderCheck.error, recordFixOutcomeFn });
    return placeholderCheck;
  }

  let missingClasses = [];
  if (pageUrl) {
    const freshness = await checkTemplateFreshnessFn({ pageUrl, templateEntry: template });
    if (freshness.ok) missingClasses = freshness.missingClasses || [];
    // freshness.ok === false is a network/infra failure, not evidence the
    // proposal is bad — nothing to surface here beyond the empty default.
  }
  return { ok: true, proposedTemplate: template, missingClasses };
}

// Runs buildComponentTemplateProposal for every action type present in a
// completed design_generate job's stored result.componentTemplates (090,
// execution_jobs.result) — used by the job-status polling route
// (routes/clients.js) so staff see one proposal per requested component key
// in a single response, keyed the same way the request was. Threads the
// job's own site_id through as siteId so a rejection recorded here scopes
// to the same site the autonomous path (resolveOrCreateComponentTemplate)
// would have hit.
export async function buildComponentTemplateProposalsFromJob(job, { pageUrl, recordFixOutcomeFn } = {}) {
  const componentTemplates = job?.result?.componentTemplates || {};
  const proposals = {};
  for (const [actionType, template] of Object.entries(componentTemplates)) {
    proposals[actionType] = await buildComponentTemplateProposal({ actionType, template, pageUrl, siteId: job?.site_id ?? null, recordFixOutcomeFn });
  }
  return proposals;
}
