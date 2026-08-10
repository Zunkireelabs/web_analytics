// The Approval Gate — composes every SYNCHRONOUS, pre-approval validation
// this app can run today into one first-class pass/fail decision, instead
// of each check being its own separate, easy-to-miss guard buried in
// approveAndPublishDraft (routes/action-center.js). "First-class" means:
// validation is never merely informational here — evaluateApprovalGate's
// `ok` is what actually decides whether a draft is allowed to leave
// 'submitted_for_approval', not a status badge a human might not notice.
//
// Two checks are wired up today:
//   - qualityGate       — generators/lib/quality-gate.js's runQualityGate()
//                          (scaffolding/duplicate-paragraph/schema-validity
//                          issues in the draft's structured content)
//   - renderingConfig    — implementers/lib/rendering-gate.js's
//                          validateRendering() (Phase 1: does the resolved
//                          file target actually get Markdown-processed)
//
// Adding a future synchronous validator (accessibility, SEO, whatever else
// can be answered from the draft's own content/target without a real
// external build) is adding one more key to the `checks` object passed in
// here — this function and its caller don't need to change shape. This
// module deliberately never fabricates a check that doesn't exist yet
// (no placeholder "accessibility: {ok: true}") — an unwired check is simply
// absent from `checks`, not silently green.
//
// Phase 2 (implementers/lib/rendering-gate.js's checkClientBuildStatus) is
// NOT a synchronous check and does not go through this function — see that
// module's own comment for why (it needs a real PR to exist first, so it
// can never block the initial approval the way these can).

export function evaluateApprovalGate(checks) {
  const entries = Object.entries(checks).filter(([, v]) => v != null);
  const failing = entries.find(([, v]) => !v.ok);
  return {
    ok: !failing,
    checks: Object.fromEntries(entries),
    blockingCheck: failing ? failing[0] : null,
    blockingError: failing ? describeFailure(failing[1]) : null,
  };
}

function describeFailure(check) {
  if (check.error) return check.error;
  if (check.issues?.length) {
    return `${check.issues.length} unresolved issue(s) (${[...new Set(check.issues.map((i) => i.patternId))].join(', ')})`;
  }
  return 'failed validation';
}
