// DESIGN/STRUCTURE REPAIR FEEDBACK — the "understand and fix" half of the
// autonomous loop, and the reason a validation failure here is not the same
// thing as a rejection.
//
// routes/action-center.js has always retried a draft that failed the
// Quality Gate, but the retry was a BLIND RE-ROLL: the same generator was
// called again with the same params, and whatever the gate had just learned
// about what was wrong was thrown away. For a flaky one-off that is enough;
// for a structural or design mismatch it is close to useless, because the
// model has no reason to answer differently the second time.
//
// This module turns the gate's own findings into a correction the generator
// can actually act on, so the loop reads:
//
//   generate -> validate -> DIAGNOSE -> route the correction back to the
//   generator -> regenerate -> validate again -> pass
//
// and only a mismatch that survives a bounded number of real repair
// attempts is ever blocked.
//
// GROUNDING RULE: every line of feedback restates something the site itself
// showed us (its canonical section order, its real text roles) or something
// a guard concretely observed in the draft. Nothing here invents a design
// preference, and with no issues carrying a `correction` it returns null —
// the caller then falls back to the plain re-roll it always did.

// Issues whose `correction` text is worth routing back. Every guard is free
// to add one; those that don't simply don't participate, which keeps this
// additive rather than a new contract every existing guard must satisfy.
function correctableIssues(issues) {
  return (issues || []).filter((i) => i && typeof i.correction === 'string' && i.correction.trim());
}

/**
 * Restates the site's own design language so a regeneration is grounded in
 * the same real facts the first attempt was given — not just told "you got
 * it wrong". Mirrors design-aware-composer.js's own grounding discipline:
 * only values this site's real pages actually showed.
 */
function designContextRecap(site, canonicalTemplate) {
  const lines = [];
  if (canonicalTemplate?.sectionOrder?.length) {
    lines.push(`This site's real "${canonicalTemplate.pageType}" pages are structured: ${canonicalTemplate.sectionOrder.join(' -> ')}.`);
  }
  if (canonicalTemplate?.textRoles?.length) {
    lines.push(`The text roles it actually uses on those pages: ${canonicalTemplate.textRoles.join(', ')}.`);
  }
  const profile = site?.url_file_map?.siteRoot?.designProfile;
  if (profile?.typography?.heading?.item || profile?.typography?.body) {
    lines.push('Match the same heading/body hierarchy those pages use — this page has to read as part of the same site, not a generic template.');
  }
  return lines;
}

/**
 * @param {Array} issues — the Quality Gate's own issues from the failed attempt.
 * @param {object} [opts]
 * @param {object} [opts.site]
 * @param {object} [opts.canonicalTemplate]
 * @returns {string|null} A correction block to append to the generator's
 *   prompt, or null when nothing actionable was found (caller re-rolls).
 */
export function buildCorrectionFeedback(issues, { site = null, canonicalTemplate = null } = {}) {
  const correctable = correctableIssues(issues);
  if (!correctable.length) return null;

  const lines = [
    'CORRECTION REQUIRED — your previous answer was generated and then checked against this site\'s own real design and known facts, and something did not match. Fix exactly these problems and keep everything else you already wrote:',
  ];
  correctable.forEach((issue, idx) => {
    lines.push(`${idx + 1}. ${issue.detail || issue.patternId} -> ${issue.correction}`);
  });

  const recap = designContextRecap(site, canonicalTemplate);
  if (recap.length) {
    lines.push('', 'For reference, this site\'s own design language:', ...recap);
  }
  return lines.join('\n');
}

/**
 * The canonical template a repair should be grounded in — resolved the same
 * way structure-conformance.js resolves it, so the feedback and the check
 * that produced it can never disagree about which template applies.
 */
export function canonicalTemplateForFeedback(site, generatorId, typesForGenerator) {
  const candidateTypes = typesForGenerator?.[generatorId];
  if (!candidateTypes) return null;
  const templates = site?.url_file_map?.siteRoot?.pageTemplates;
  if (!templates || typeof templates !== 'object') return null;
  for (const type of candidateTypes) {
    const t = templates[type];
    if (t && (t.sectionOrder?.length || t.textRoles?.length)) return t;
  }
  return null;
}
