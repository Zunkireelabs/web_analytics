// THE ONE POLICY. Every check (classification, baseline, patterns, render, outside, headings, shared files) feeds this one pure function, so "may this
// visible change ship?" has exactly one answer, and the answer says why. Nothing here assumes a pass: a visible change with no baseline, no existing
// pattern to copy, or no way to render it is WAITING (awaiting-baseline / awaiting-verification) or NEEDS INPUT, never "ok by default".
//
// verdicts
//   not-visible          confirmed not to change rendered output: nothing to judge
//   pass                 visible, and every check measured a match
//   awaiting-baseline    no usable captured baseline for this exact template: it is being captured; the item waits (transient)
//   awaiting-verification a check could not run (page unreachable, no body region, shared file needs a build preview): not a pass, not evidence; retried
//   needs-input          the template has no existing pattern of this kind to copy (a FAQ, table, related list, breadcrumb): nothing is invented
//   blocked              measured to differ from the template (or damage something outside the change)
// `blocked` (the flag) is mode-aware: only 'enforce' holds. `wouldBlock` is true in every mode, so the log period measures false positives.

export const REPAIRABLE_KINDS = new Set(['foreign-classes', 'font-family', 'text-color', 'link-color', 'font-weight', 'heading-scale', 'body-size', 'line-height', 'table-text-size', 'faq-question-style', 'radius', 'second-h1', 'skipped-heading-level', 'mobile-overflow']);
// Never repaired by rewriting the change: they say the change reached outside itself or the template cannot hold it.
export const NOT_REPAIRABLE_KINDS = new Set(['outside-changed', 'container-width', 'unrelated-pages-changed']);

export function decideProtection({ mode = 'log', classification, baseline = null, patternPresent = null, render = null, sharedPaths = [], sharedPreview = null, renderRequired = true } = {}) {
  const base = (verdict, reasons = [], extra = {}) => {
    const wait = verdict === 'awaiting-baseline' || verdict === 'awaiting-verification' || verdict === 'needs-input' || verdict === 'blocked';
    return { verdict, reasons, wouldBlock: wait, blocked: wait && mode === 'enforce', repairable: false, ...extra };
  };
  if (!classification?.visible) return { verdict: 'not-visible', reasons: classification?.reasons?.map((detail) => ({ code: 'not-visible', detail })) || [], wouldBlock: false, blocked: false, repairable: false };

  if (!baseline?.usable) return base('awaiting-baseline', [{ code: `baseline-${baseline?.reason || 'missing'}`, detail: baseline?.detail || null }], { transient: true });

  if (classification.format && patternPresent === false) {
    return base('needs-input', [{ code: 'no-existing-pattern', detail: `this template shows no ${classification.kind} anywhere to copy the format from, so none is invented` }]);
  }

  if (sharedPaths.length) {
    if (!sharedPreview || sharedPreview.status === 'none') return base('awaiting-verification', [{ code: 'shared-file-needs-build-preview', detail: `changes ${sharedPaths.slice(0, 3).join(', ')}, which many pages use; it cannot be judged without a built preview` }], { transient: true });
    if (sharedPreview.status === 'unreachable') return base('awaiting-verification', [{ code: 'preview-unreachable', detail: sharedPreview.detail || 'the built preview could not be loaded' }], { transient: true });
    if (sharedPreview.status === 'differs') return base('blocked', [{ code: 'unrelated-pages-changed', detail: sharedPreview.detail || 'other pages on this layout render differently' }], { evidence: { unrelated: sharedPreview } });
  }

  // A change with no markup of its own (a stylesheet edit) has nothing to render: what protects the site is the unrelated-pages check above, which passed.
  if (!renderRequired && sharedPaths.length) return { verdict: 'pass', reasons: [{ code: 'unrelated-pages-unchanged', detail: 'other pages on this layout render the same with the change' }], wouldBlock: false, blocked: false, repairable: false };
  if (!render || render.status !== 'ok') {
    return base('awaiting-verification', [{ code: render?.status === 'no-region' ? 'no-body-region' : 'render-could-not-run', detail: render?.error || render?.status || 'not run' }], { transient: true });
  }

  const found = [...(render.deviations || []), ...(render.outside || []), ...(render.heading || []), ...(render.overflow || [])];
  if (found.length) {
    const repairable = found.every((d) => REPAIRABLE_KINDS.has(d.kind)) && !found.some((d) => NOT_REPAIRABLE_KINDS.has(d.kind));
    return base('blocked', found.map((d) => ({ code: d.kind, detail: d.detail || `${d.expected} → ${d.actual} (${d.viewport})`, viewport: d.viewport || null })), { repairable });
  }
  return { verdict: 'pass', reasons: [{ code: 'matches', detail: 'every check measured a match at 1440 and 390 px' }], wouldBlock: false, blocked: false, repairable: false };
}
