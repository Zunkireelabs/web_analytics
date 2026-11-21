// The runtime half of autonomous design repair (design-repair.js): what happens
// to a diagnosis that the generator cannot fix by rewriting. Kept apart from the
// pure loop so the loop stays testable without a database or a job queue.
//
//   learn          -> THIS TENANT's design lessons (design-knowledge store).
//                     Evidence here may name the client's own classes and pages:
//                     it is read back only for that site.
//   designCapture  -> the Design Agent re-captures the live site
//                     (design-block-repair.js, with its cooldown intact).
//   sharedCode     -> the platform's own engineering repair
//                     (code-self-repair.js: sandbox, independent validation,
//                     human-merged PR, off unless ENABLE_CODE_SELF_REPAIR).
//
// THE WALL. Shared engineering lessons are visible to every tenant, so what
// crosses to them is built by sharedEvidenceText() from structure and numbers
// only — never a class name, URL, selector or piece of client copy. The same
// rule the rest of the lesson store follows (agent-memory.js sanitizeLessonText).
import { OWNER } from './design-repair.js';

const KIND_OF_FAILURE = (reason) => (reason === 'responsive-regression' || reason === 'render-deviation' || reason === 'design-incomplete' ? reason : 'render-deviation');

const pageOf = (draft) => draft?.input?.page || draft?.input?.pageUrl || draft?.content?.page || null;

/**
 * Builds the `learn` callback for one draft. Records ONE lesson per episode, for
 * this tenant only: a fix when the repair held, an anti-pattern when it did not.
 */
export function tenantLessonRecorder({ siteId, draft, mode = 'enforce', recordFix = null, recordFailure = null }) {
  return async ({ outcome, diagnosis, attempts, failure }) => {
    const store = (recordFix && recordFailure) ? null : await import('../../store/design-knowledge.js');
    const fix = recordFix || store.recordDesignFix;
    const anti = recordFailure || store.recordDesignFailure;
    const fixed = outcome === 'fixed';
    const detail = [diagnosis?.cause, ...(diagnosis?.evidence || []).slice(0, 5)].filter(Boolean).join(' | ');
    const tried = (attempts || []).map((a) => `${a.owner}: ${a.action || 'checked'}${a.outcome ? ` -> ${a.outcome}` : ''}`).join('; ');
    const record = fixed ? fix : anti;
    await record(siteId, {
      patternId: KIND_OF_FAILURE(failure?.reason),
      pageUrl: pageOf(draft),
      generatorId: draft?.action_type || null,
      detail,
      correction: fixed
        ? `Repaired automatically after: ${tried}`
        : `Did not hold after automatic repair (${outcome}). Tried: ${tried || 'nothing'}`,
      draftId: draft?.id ?? null,
      validation: { passed: fixed, gate: 'design-repair', mode },
    });
  };
}

// Where the platform's own code for each shared cause lives. Generic repo paths — never client data — so the
// engineering agent starts in the right place and runs the right test.
export const ENGINEERING_TARGETS = Object.freeze({
  [OWNER.SHARED_RENDERER]: {
    files: ['server/implementers/lib/newpage-render.js', 'server/implementers/lib/marker-merge.js'],
    test: 'server/implementers/lib/newpage-render.test.js',
  },
  [OWNER.VALIDATION_GATE]: {
    files: ['server/design-agent/live-analysis/body-measure.js', 'server/generators/lib/newpage-render-gate.js', 'server/generators/lib/responsive-preview-gate.js'],
    test: 'server/design-agent/live-analysis/body-measure.browser.test.js',
  },
});

// What may leave the tenant: the kind of cause, the kind of measurement and its
// size — nothing that identifies a client.
export function sharedEvidenceText(diagnosis, failure) {
  const measured = (failure?.deviations || []).map((d) => `${d.kind} (site ${d.expected}, draft ${d.actual}, ${d.viewport})`);
  const regressed = (failure?.regressions || []).map((r) => `${r.kind} at ${r.width}px`);
  const text = [
    `A draft failed design validation and the diagnosis assigns it to ${diagnosis?.owner || 'the platform'}.`,
    `Cause class: ${diagnosis?.owner === OWNER.VALIDATION_GATE
      ? 'the check does not reproduce a page\'s own rendering (the page\'s own body, re-injected, still deviates)'
      : 'the rendered markup lost structure (wrapper or element classes) that the site\'s stylesheet depends on'}.`,
    measured.length ? `Measured: ${measured.join('; ')}.` : '',
    regressed.length ? `Regressions: ${regressed.join('; ')}.` : '',
    `${(diagnosis?.evidence || []).filter((e) => /classes/.test(e)).length ? 'Some' : 'No'} body-element classes were missing from the rendered markup.`,
    ENGINEERING_TARGETS[diagnosis?.owner] ? `Start in: ${ENGINEERING_TARGETS[diagnosis.owner].files.join(', ')}. Regression test: ${ENGINEERING_TARGETS[diagnosis.owner].test}.` : '',
  ].filter(Boolean).join(' ');
  return text.slice(0, 700);
}

/**
 * The owner hand-offs for one draft. Each returns a short string describing what
 * happened and never throws (design-repair.js treats a failing hand-off as
 * "deferred", never as success).
 */
export function buildHandoffs({ site, draft, requestRefresh = null, accept = null }) {
  return {
    designCapture: async () => {
      const fn = requestRefresh || (await import('../../design-agent/lib/design-block-repair.js')).requestProfileRefresh;
      const r = await fn(site);
      // 'already-queued' and 'cooldown' mean a re-capture is pending or was just done: someone IS on it. The rest
      // (no repo, no page url, an error) mean no re-capture will happen, so it must not be reported as deferred.
      const inHand = r.queued || r.reason === 'already-queued' || r.reason === 'cooldown';
      return { requested: inHand, detail: `design re-capture: ${r.reason}` };
    },
    sharedCode: async (diagnosis, failure = null) => {
      const fn = accept || (await import('../../agents/lib/code-self-repair.js')).acceptDesignRepairTask;
      const r = await fn({
        generatorId: draft?.action_type,
        // A stable signature per ROOT CAUSE, not per page: the same defect on ten pages or three clients groups into
        // one engineering problem. (The signature is derived from `owner`.)
        owner: diagnosis.owner,
        errorMessage: sharedEvidenceText(diagnosis, failure),
        testFileHint: ENGINEERING_TARGETS[diagnosis.owner]?.test || null,
      });
      // Accepted = a repair is running, exists, or was just started. Anything else (feature off, already given up on,
      // could not check) means nobody has taken it: the caller must not defer.
      return { requested: r.accepted === true, detail: `shared code repair: ${r.reason}` };
    },
  };
}
