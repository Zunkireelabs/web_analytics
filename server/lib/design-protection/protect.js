// STRICT DESIGN PROTECTION: the single entry point every VISIBLE change passes before it may ship.
//
//   classify -> template -> baseline (never assumed) -> pattern to copy (never invented) -> shared-file preview -> render before/after at 1440+390
//   -> ONE decision (decide.js) -> bounded repair -> record the decision -> quarantine with content kept (never abandon) or pass
//
// It never changes a threshold, never ships a failed change, never borrows another client's or another template's design, and never turns "could not
// check" into a pass. In 'log' mode (the default) it records everything and what WOULD have been held, and the existing gates keep enforcing.
import { classifyChange, touchesSharedFiles } from './classify-change.js';
import { templateKeyFor, referencePagesFor } from './template.js';
import { baselineUsability } from './store.js';
import { decideProtection } from './decide.js';
import { repairLoop } from './repair.js';
import { designProtectionMode, designRepairAttempts } from './mode.js';

const RETRY_POLICY_FOR = { 'awaiting-baseline': 'retry', 'awaiting-verification': 'retry', 'needs-input': 'needs_human', blocked: 'item_defect' };

export const describeProtection = (r) => {
  if (!r || r.verdict === 'pass' || r.verdict === 'not-visible') return '';
  const why = (r.reasons || []).slice(0, 4).map((x) => `${x.code}${x.detail ? ` (${typeof x.detail === 'string' ? x.detail : JSON.stringify(x.detail).slice(0, 120)})` : ''}`).join('; ');
  const lead = { 'awaiting-baseline': 'The design baseline for this page\'s template is being captured, so this waits rather than ship unchecked', 'awaiting-verification': 'The design check could not run, so this waits rather than ship unchecked', 'needs-input': 'This needs a person: the site has nothing to copy the format from', blocked: 'This change does not match the site\'s design' }[r.verdict] || 'Held';
  return `${lead}: ${why}.`;
};

/**
 * @param {object} a
 *   site, mode override (tests); change = { generatorId, actionType, draftId, recommendationId, findingId, pageUrl, html, marker, files, titleIsHeadline, previewUrlFor }
 *   deps = { store, renderCheck, checkUnrelated, quarantine, loadProfile }  (all injectable; defaults are the real ones)
 * @returns {Promise<{ok:boolean, mode, verdict, blocked:boolean, wouldBlock:boolean, pending:boolean, reason:string|null, error:string|null, html:string, repaired:boolean, reasons:object[], evidence:object}>}
 */
export async function protectVisibleChange({ site, change, mode = designProtectionMode(), deps = {} } = {}) {
  const store = deps.store || await import('./store.js');
  const cls = classifyChange({ generatorId: change.generatorId || change.actionType, files: change.files || null, titleIsHeadline: change.titleIsHeadline });
  const out = (decision, extra = {}) => ({
    ok: !decision.blocked, mode, verdict: decision.verdict, blocked: decision.blocked, wouldBlock: decision.wouldBlock,
    pending: decision.verdict === 'awaiting-baseline' || decision.verdict === 'awaiting-verification',
    reason: decision.reasons?.[0]?.code || null, error: decision.blocked ? describeProtection(decision) : null,
    html: change.html, repaired: false, reasons: decision.reasons || [], evidence: {}, ...extra,
  });
  if (mode === 'off') return { ok: true, mode, verdict: 'skipped', blocked: false, wouldBlock: false, pending: false, reason: null, error: null, html: change.html, repaired: false, reasons: [], evidence: {} };

  const record = async (decision, extra = {}) => store.recordProtectionDecision(site.id, {
    draftId: change.draftId, actionType: change.actionType || change.generatorId, templateKey: extra.templateKey, pageUrl: change.pageUrl, visible: cls.visible,
    verdict: decision.verdict, mode, blocked: decision.blocked, wouldBlock: decision.wouldBlock, repaired: Boolean(extra.repaired), reasons: decision.reasons, evidence: { classification: cls, ...(extra.evidence || {}) },
  });

  // 1. not visible: nothing to judge (still recorded, so the log shows what was classified and why)
  if (!cls.visible) { const d = decideProtection({ mode, classification: cls }); await record(d); return out(d); }

  // 2. which template, and its baseline. No template or no usable baseline => capture is requested and the change WAITS.
  const profile = deps.loadProfile ? await deps.loadProfile(site) : (site?.url_file_map?.siteRoot?.designProfile || null);
  const template = templateKeyFor(profile, change.pageUrl, { pageType: change.pageType || null });
  let row = null; let usability = { usable: false, reason: 'no-template', detail: 'this page matches no captured template' };
  if (template) {
    row = await store.getBaseline(site.id, template.key);
    usability = baselineUsability(row);
    // Nothing usable: ask for a capture (idempotent; an already-requested row is left alone). The change waits as awaiting-baseline meanwhile.
    if (!usability.usable && usability.reason !== 'capture-requested') await store.requestBaseline(site.id, template.key).catch(() => {});
  }
  const baseline = usability.usable ? { ...row, usable: true, reason: 'ready' } : { usable: false, reason: usability.reason, detail: usability.detail };
  const patternPresent = cls.format && usability.usable ? Boolean(row.patterns?.[cls.kind]?.present) : null;

  // 3. shared files: other pages of this layout must be unchanged, judged from a built preview. Without one the change waits.
  const sharedPaths = touchesSharedFiles((change.files || []).map((f) => f.path));
  let sharedPreview = null;
  if (sharedPaths.length && usability.usable) {
    const origin = change.origin || (() => { try { return new URL(change.pageUrl).origin; } catch { return null; } })();
    const live = referencePagesFor(template, { excludeUrl: change.pageUrl, max: 3 }).map((u) => { try { return new URL(u, origin).href; } catch { return null; } }).filter(Boolean);
    sharedPreview = await (deps.checkUnrelated || (await import('./unrelated.js')).checkUnrelatedPages)({ liveUrls: live, previewUrlFor: change.previewUrlFor || null });
  }

  // 4. render before/after, only when a baseline exists and there is markup to render (a shared-file-only change has none)
  // A NEW page has no live URL yet: it is rendered into a real page of the SAME template (the reference), as the whole body region.
  let renderUrl = change.pageUrl; let insertMode = change.insertMode || (change.marker ? 'marker' : 'append');
  if (change.newPage) {
    const ref = referencePagesFor(template, { max: 1 })[0];
    try { renderUrl = ref && change.origin ? new URL(ref, change.origin).href : null; } catch { renderUrl = null; }
    insertMode = 'region';
  }
  // Markup that cannot be rendered from source alone (template syntax, JSX) is NOT a pass: it needs a built preview, so it waits as awaiting-verification.
  const canRender = usability.usable && change.html != null && renderUrl && patternPresent !== false && !change.unrenderable;
  const renderOnce = async (html) => (deps.renderCheck || (await import('./render-check.js')).runDesignRenderCheck)({
    pageUrl: renderUrl, html, mode: insertMode, marker: change.marker || null, baseline: row,
  });
  const decideFor = (render) => decideProtection({ mode, classification: cls, baseline, patternPresent, render, sharedPaths, sharedPreview, renderRequired: change.html != null || Boolean(change.unrenderable) });

  let render = canRender ? await renderOnce(change.html) : (change.unrenderable && usability.usable ? { status: 'unrenderable', error: `cannot be rendered from source (${change.unrenderable}); it needs a built preview` } : null);
  let decision = decideFor(render);
  let finalHtml = change.html; let repair = null;

  // 5. bounded repair, enforce mode only (log mode must never alter what ships). Re-checked by the same check that failed it.
  if (decision.verdict === 'blocked' && decision.repairable && mode === 'enforce' && designRepairAttempts() > 0 && canRender) {
    repair = await repairLoop({ html: change.html, baseline: row, maxAttempts: designRepairAttempts(), initial: decision, check: async (html) => decideFor(await renderOnce(html)) });
    if (repair.final.verdict === 'pass') { finalHtml = repair.html; decision = repair.final; }
    else decision = { ...repair.final, reasons: repair.final.reasons };
  }

  const evidence = { template, baseline: { status: usability.reason, sampleUrls: row?.sample_urls || null, confidence: row?.confidence || null }, render: render ? { status: render.status, ...(render.evidence || {}) } : null, repair: repair ? { attempts: repair.attempts, repaired: repair.repaired } : null, sharedPaths, sharedPreview: sharedPreview && { status: sharedPreview.status } };
  await record(decision, { templateKey: template?.key || null, repaired: repair?.repaired, evidence });

  // 6. a held change is QUARANTINED with its content kept (a delivery_items row, never an abandoned draft); siblings are untouched.
  if (decision.blocked) {
    const quarantine = deps.quarantine || (async (...a) => (await import('../delivery-cycle.js')).recordItemOutcome(...a));
    await quarantine(site.id, {
      recommendationId: change.recommendationId ?? null, findingId: change.findingId ?? null, draftId: change.draftId ?? null, outcome: 'failed',
      failureClass: `design-protection:${decision.verdict}`, retryPolicy: RETRY_POLICY_FOR[decision.verdict] || 'needs_human', reason: describeProtection(decision),
      generatorId: change.generatorId || change.actionType || null, page: change.pageUrl || null,
    }).catch(() => {});
  }
  return out(decision, { html: finalHtml, repaired: Boolean(repair?.repaired), evidence });
}

/** For auto-remediation's design-pending path: a waiting verdict becomes the error that path already understands (skip, count nothing, keep open). */
export async function toPendingError(result, pageUrl = null) {
  const { DesignValidationPending } = await import('../../design-agent/lib/design-validation-stage.js');
  return new DesignValidationPending(describeProtection(result), { reason: result.reason || result.verdict, transient: true, pageUrl });
}
