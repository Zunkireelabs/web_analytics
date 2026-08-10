import { validatePlaceholders, checkTemplateFreshness, COMPONENT_TEMPLATE_KEY } from '../implementers/lib/design-drift.js';

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
export async function buildComponentTemplateProposal({ actionType, template, pageUrl, checkTemplateFreshnessFn = checkTemplateFreshness }) {
  if (!COMPONENT_TEMPLATE_KEY[actionType]) {
    return { ok: false, error: `"${actionType}" has no component-template concept — only ${Object.keys(COMPONENT_TEMPLATE_KEY).join(', ')} do.` };
  }
  if (!template?.wrapper || !template?.row) {
    return { ok: false, error: 'Design Agent did not report a template for this action type.' };
  }

  const placeholderCheck = validatePlaceholders(actionType, template);
  if (!placeholderCheck.ok) return placeholderCheck;

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
// in a single response, keyed the same way the request was.
export async function buildComponentTemplateProposalsFromJob(job, { pageUrl } = {}) {
  const componentTemplates = job?.result?.componentTemplates || {};
  const proposals = {};
  for (const [actionType, template] of Object.entries(componentTemplates)) {
    proposals[actionType] = await buildComponentTemplateProposal({ actionType, template, pageUrl });
  }
  return proposals;
}
