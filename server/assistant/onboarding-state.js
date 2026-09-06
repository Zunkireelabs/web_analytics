import { FAILURE_CLASS } from '../lib/failure-classification.js';

// Onboarding state, recommendations, and failure explanations — all derived
// from structured system state, never asserted by a model (Phase 3, §5/§7/§12).
//
// The organising idea is that onboarding is PER-CATEGORY, not global. A site
// whose design profile is blocked but whose routes and insertion points are
// configured is genuinely usable for most autonomous work, and reporting that
// as "onboarding failed" would be both wrong and unhelpful (§5).

export const ASSISTANT_STATE = {
  IDLE: 'IDLE',
  DISCOVERING: 'DISCOVERING',
  REVIEWING: 'REVIEWING',
  NEEDS_INPUT: 'NEEDS_INPUT',
  READY: 'READY',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
};

// Categories whose "unresolved" state means a CAPABILITY is genuinely absent
// (the Design Agent hasn't run — see design-profile in run-discovery.js,
// which records exactly one present/absent finding, never a set of
// candidates), as opposed to every other category's unresolved items, which
// are real decisions with evidence and candidates behind them. That is the
// difference between BLOCKED ("I have nothing to offer you here, and no
// choice you make fixes it") and NEEDS_INPUT ("choose, and I proceed") — not
// how many items happen to be unresolved.
const CAPABILITY_GAP_CATEGORIES = new Set(['design-profile']);

// Derives overall state plus a per-category breakdown from the summary rows
// store/site-understanding.js produces. Pure: same input, same output, no I/O.
export function deriveOnboardingState({ categories = [], repoConnected = false } = {}) {
  if (!repoConnected) {
    return {
      state: ASSISTANT_STATE.BLOCKED,
      percentComplete: 0,
      categories: [],
      blockers: [{
        category: 'repository',
        reason: 'No repository is connected, so there is nothing to inspect.',
        // Authorization to a client's repo cannot be granted automatically —
        // naming that plainly is more useful than implying it might resolve.
        humanAction: 'Connect this site\'s GitHub repository.',
      }],
      needsInput: [],
    };
  }
  if (!categories.length) {
    return { state: ASSISTANT_STATE.IDLE, percentComplete: 0, categories: [], blockers: [], needsInput: [] };
  }

  const breakdown = categories.map((c) => ({
    category: c.category,
    total: c.total,
    ready: c.ready,
    unresolved: c.unresolved,
    state: c.unresolved > 0
      ? (CAPABILITY_GAP_CATEGORIES.has(c.category) ? 'BLOCKED' : 'NEEDS_INPUT')
      : (c.ready > 0 ? 'READY' : 'BLOCKED'),
  }));

  const totalItems = breakdown.reduce((n, c) => n + c.total, 0);
  const readyItems = breakdown.reduce((n, c) => n + c.ready, 0);

  const blockers = breakdown.filter((c) => c.state === 'BLOCKED');
  const needsInput = breakdown.filter((c) => c.state === 'NEEDS_INPUT');

  // Precedence: a decision the human can make outranks an obstacle they
  // cannot, because it is the thing they can actually act on right now.
  let state = ASSISTANT_STATE.READY;
  if (needsInput.length) state = ASSISTANT_STATE.NEEDS_INPUT;
  else if (blockers.length) state = ASSISTANT_STATE.BLOCKED;

  return {
    state,
    percentComplete: totalItems ? Math.round((readyItems / totalItems) * 100) : 0,
    categories: breakdown,
    blockers,
    needsInput,
  };
}

// Ranks the candidates of an unresolved decision using its own recorded
// evidence, so the Assistant can recommend rather than merely ask (§7).
//
// The recommendation is explicitly NOT permission to act: for a high-risk
// item the caller still gates on human confirmation. "AI does the reasoning;
// human makes the final high-risk decision."
export function recommendForFinding(finding) {
  const evidence = finding.evidence || [];
  const confidence = Number(finding.confidence) || 0;

  // High risk is not exclusively "shared infrastructure" — a data-source
  // finding can also be high risk (a data file feeding more than one route).
  // The explanation must name what actually makes it risky, category by
  // category, or a data-source item reads as a layout when it never was.
  const RISK_REASON = {
    'shared-infrastructure': 'This file is shared — inherited by many pages — so choosing wrongly would change more than one page at once.',
    'data-source': 'This data file may feed more than one generated page, so a wrong mapping could affect all of them at once.',
    deployment: 'This changes deployment configuration, which affects how the whole site ships, not one page.',
  };

  const base = {
    subject: finding.subject,
    category: finding.category,
    risk: finding.risk,
    confidence,
    evidence,
    // Why a human is being consulted at all — the answer to "why are you
    // asking me this?" (§6).
    whyAsking: finding.risk === 'high'
      ? `${RISK_REASON[finding.category] || 'Getting this wrong could affect many pages at once.'} Confidence alone does not make that safe to apply unattended.`
      : `The available evidence was not strong enough to establish this without a decision (confidence ${confidence.toFixed(2)}).`,
  };

  const candidates = finding.finding?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      ...base,
      recommendation: null,
      // No invented option. Deferring is a legitimate outcome (§6, "I'm not
      // sure" must never force a guess).
      canDefer: true,
    };
  }

  // Score by corroboration: how much the repository itself supports each
  // candidate. Deliberately arithmetic over recorded evidence rather than a
  // model's opinion (§21).
  const scored = candidates
    .map((c) => ({ ...c, score: (c.routeCount || 0) + (c.supportingEvidence?.length || 0) * 2 }))
    .sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  const margin = second ? best.score - second.score : best.score;

  return {
    ...base,
    recommendation: margin > 0 ? best : null,
    alternatives: scored.slice(1),
    // A tie is reported as a tie. Presenting an arbitrary pick as a
    // recommendation would be exactly the false confidence this avoids.
    recommendationConfidence: margin === 0 ? 0 : Math.min(0.95, 0.5 + margin / 20),
    canDefer: true,
  };
}

// Turns a Phase 1 classification into something a non-engineer can act on
// (§12). Every branch is keyed off the structured class — never guessed from
// message text — and says who can fix it, which is the distinction that makes
// the difference between waiting and acting.
const FAILURE_GUIDANCE = {
  [FAILURE_CLASS.DEPLOYMENT]: {
    meaning: 'The agent itself did not fail — the environment it needs was unavailable, so the work never started.',
    systemWillDo: 'Nothing automatically — no amount of attempting again fixes a missing environment.',
    youShouldDo: 'An engineer needs to restore or redeploy the affected environment.',
  },
  [FAILURE_CLASS.EXTERNAL_SERVICE]: {
    meaning: 'A third-party service was temporarily unreachable.',
    systemWillDo: 'Retry automatically, with backoff, up to the attempt limit.',
    youShouldDo: 'Nothing — this usually clears on its own.',
  },
  [FAILURE_CLASS.CLIENT_REPO]: {
    meaning: "The site's repository could not be read — typically an expired token or changed access.",
    systemWillDo: 'Nothing automatically — attempting again cannot restore access that was revoked.',
    youShouldDo: "Re-authorize this site's GitHub access.",
  },
  [FAILURE_CLASS.AGENT_LOGIC]: {
    meaning: 'The agent produced a result that failed validation, so it was rejected rather than saved.',
    systemWillDo: 'Nothing automatically: the same input would produce the same rejected output.',
    youShouldDo: 'Nothing — this is ours to fix in code.',
  },
  [FAILURE_CLASS.INVALID_INPUT]: {
    meaning: "The job's inputs did not describe an actionable change.",
    systemWillDo: 'Nothing automatically.',
    youShouldDo: 'Usually nothing — the underlying configuration needs correcting.',
  },
  [FAILURE_CLASS.UNSAFE]: {
    meaning: 'The agent declined to act because a safety rule applied. This is the system working, not malfunctioning.',
    systemWillDo: 'Nothing — the refusal is deliberate.',
    youShouldDo: 'Review whether the action should be permitted at all.',
  },
};

export function explainFailure(failure) {
  // No structured evidence means no explanation is invented (§12).
  if (!failure || !failure.failureClass) {
    return {
      known: false,
      headline: 'This job failed before the system recorded a structured reason.',
      detail: 'It predates failure classification, so there is nothing reliable to explain. The worker logs hold the raw error.',
    };
  }

  const guidance = FAILURE_GUIDANCE[failure.failureClass] || {
    meaning: 'The failure did not match a known category.',
    systemWillDo: 'Nothing automatically — an unrecognised failure is treated as ours to investigate.',
    youShouldDo: 'No action yet.',
  };

  return {
    known: true,
    headline: failure.message,
    classification: failure.failureClass,
    errorCode: failure.errorCode,
    stage: failure.stage,
    meaning: guidance.meaning,
    systemWillDo: guidance.systemWillDo,
    youShouldDo: guidance.youShouldDo,
    // Surfaces the Phase 1 retry story so a job that recovered after two
    // failed attempts reads as a success, not an incident (§13).
    attempts: failure.attempts ?? 1,
    recoverable: !!failure.recoverable,
    infrastructure: !!failure.infrastructure,
    originalFailure: failure.firstFailure
      ? { errorCode: failure.firstFailure.errorCode, classification: failure.firstFailure.failureClass }
      : null,
  };
}
