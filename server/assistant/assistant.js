import { invokeCapability, capabilitiesFor } from './capabilities.js';
import { deriveOnboardingState, recommendForFinding, explainFailure, ASSISTANT_STATE } from './onboarding-state.js';

// The Assistant's reasoning loop (Phase 3, §2/§6/§16/§21).
//
//   intent -> existing capability -> structured result -> reasoning -> answer
//
// The LLM is never the source of truth and never holds the data: intents map
// to capabilities, capabilities return structured results, and the reply is
// composed from those results. That is the difference between an assistant
// over a system and a chat window with the database pasted into a prompt.
//
// Intent routing is deterministic first for the same reason discovery is:
// "does this message ask for status" is a cheap, checkable classification, and
// a deterministic router cannot hallucinate a capability that does not exist.

const INTENTS = [
  { id: 'status', patterns: [/\bhow('s| is)?\b.*\b(onboarding|going|progress|setup)\b/i, /\bstatus\b/i, /\bhow far\b/i] },
  { id: 'needs_from_me', patterns: [/what do you need/i, /\bneed from me\b/i, /what.*\b(should|do)\b.*\bi\b.*\bdo\b/i, /\bblock(ing|ers?)\b/i] },
  { id: 'explain', patterns: [/\bwhy\b/i, /\bexplain\b/i, /what does .* mean/i] },
  { id: 'confirm', patterns: [/\b(use|choose|pick|select)\b.*\b(first|second|option|a|b|one)\b/i, /\bconfirm\b/i, /\byes,? (use|go|do)\b/i] },
  { id: 'run_discovery', patterns: [/\b(run|start|begin|redo|refresh)\b.*\b(discovery|onboarding|scan|inspect)\b/i, /\bconfigure the\b/i, /\bset ?up\b/i] },
  { id: 'run_remediation', patterns: [/\b(ship|fix|remediat\w*)\b.*\b(safe|what.?s safe|today|now)\b/i, /\brun (safe )?remediation\b/i, /\bfix everything safe\b/i] },
  { id: 'do_it', patterns: [/^\s*(do it|go ahead|proceed|continue|carry on)\s*[.!]?\s*$/i] },
  { id: 'failures', patterns: [/\b(fail(ed|ure)s?|error|broke|not working|why did .* fail)\b/i] },
  { id: 'agent_work', patterns: [/\b(what|anything)\b.*\b(agents?|autonomous|today|happened|done)\b/i, /\bactivity\b/i] },
  { id: 'unsure', patterns: [/\b(i('m| am)? not sure|dunno|don't know|unsure|no idea)\b/i] },
];

// Deterministic match first; 'unknown' is an honest outcome that leads to a
// capability list rather than a guess at what was meant.
export function classifyIntent(message) {
  const text = String(message || '');
  for (const intent of INTENTS) {
    if (intent.patterns.some((p) => p.test(text))) return intent.id;
  }
  return 'unknown';
}

// Every role's fallback for a question the deterministic intents above don't
// cover — "why did traffic drop", "which pages have wins", anything about
// the site's real data rather than its onboarding state. Tries the
// findings-routing engine (ask_growth_copilot, the former standalone
// "Growth Copilot") FIRST for everyone: it already covers the full agent
// catalog (SEO, GEO, AEO, security, content...), not just statistics, and
// carries real cited evidence + a Generate Draft affordance the plainer
// Python stats path below cannot produce.
//
// A platform_admin gets a SECOND attempt at the standalone data-analyst-agent
// (deeper forecasting/keyword-distance tools the findings engine doesn't
// have) only if the first call outright failed — not merely answered
// honestly that it had nothing, which is a real answer, not a failure.
// ask_analyst_data's own requiredRole enforces platform_admin too — belt and
// suspenders, since this is what lets an ambiguous question reach it at all.
//
// Failures (either service unreachable) are swallowed, never surfaced as a
// raw error, because the caller always has the deterministic capability-list
// reply to fall back to.
async function tryDataFallback(ctx, message, conversationId, deps) {
  try {
    const result = await invokeCapability('ask_growth_copilot', ctx, { message, conversationId }, deps);
    if (result.ok) {
      return {
        state: ASSISTANT_STATE.READY,
        message: result.data.answer,
        data: { conversationId: result.data.conversationId, citedFindings: result.data.citedFindings, followUps: result.data.followUps },
        actions: (result.data.followUps || []).map((q) => ({ id: 'follow_up', label: q })),
      };
    }
  } catch { /* fall through to the admin-only stats path below */ }

  if (ctx.role !== 'platform_admin') return null;
  try {
    const result = await invokeCapability('ask_analyst_data', ctx, { question: message }, deps);
    if (!result.ok) return null;
    return { state: ASSISTANT_STATE.READY, message: result.data.answer, data: { toolCalls: result.data.toolCalls }, actions: [] };
  } catch {
    return null;
  }
}

// Which unresolved item a message refers to.
//
// Named reference is tried FIRST and is the important case: "why are you
// asking about src/blog/x.njk" must resolve to that exact finding, not to
// whatever happens to sort first. This works without any per-conversation
// memory because it matches directly against the current unresolved set —
// a real, tested guarantee — rather than against a "what did I just show
// this user" history this module does not keep (see the module-level note
// below on that limitation).
//
// "first"/"second" is the fallback for a message with no identifiable
// subject, and a bare confirmation with neither falls through to the
// top of the (deterministically ordered) queue — a defensible default,
// not a guess at intent.
function resolveReference(message, unresolved) {
  if (!unresolved.length) return null;
  const text = String(message || '');

  // Picks the LONGEST matching subject, not the first in array order. A
  // short subject like "src" (a root-level page-type directory) is a
  // substring of nearly any real path, so "...src/_includes/components/
  // author-cards.njk..." trivially contains "src" too — first-match order
  // let that generic entry win over the actual full path named in the
  // message, purely because it happened to sort earlier. Specificity, not
  // position, is what should decide.
  const matches = unresolved
    .map((u) => {
      const base = u.subject.split('/').pop();
      const hit = text.includes(u.subject) ? u.subject : (base && base.length > 3 && text.includes(base) ? base : null);
      return hit ? { u, len: hit.length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.len - a.len);
  if (matches.length) return matches[0].u;

  const lower = text.toLowerCase();
  if (/\bsecond\b|\b2nd\b|\boption b\b/.test(lower)) return unresolved[1] || null;
  if (/\bfirst\b|\b1st\b|\boption a\b/.test(lower)) return unresolved[0] || null;
  return unresolved[0];
}

// Every reply is { state, message, data, actions } — `data` is the structured
// result the message was composed from, so a UI can render richly and a
// reviewer can check that the words match the system's actual state.
export async function handleMessage({ ctx, message, deps = {}, conversationId = null } = {}) {
  const intent = classifyIntent(message);

  const status = await invokeCapability('get_onboarding_status', ctx, {}, deps);
  if (!status.ok) return { state: ASSISTANT_STATE.FAILED, message: status.remedy || 'Unable to read onboarding status.', data: status, actions: [] };

  const onboarding = deriveOnboardingState({
    categories: status.data.categories,
    repoConnected: status.data.site.repoConnected,
  });

  const unresolvedResult = await invokeCapability('list_unresolved_decisions', ctx, {}, deps);
  const unresolved = unresolvedResult.ok ? unresolvedResult.data : [];

  switch (intent) {
    case 'status': {
      return {
        state: onboarding.state,
        message: composeStatus(status.data.site, onboarding, unresolved),
        data: { onboarding, unresolvedCount: unresolved.length },
        actions: unresolved.length ? [{ id: 'list_unresolved_decisions', label: 'Show what needs my decision' }] : [],
      };
    }

    case 'needs_from_me': {
      const asks = unresolved.slice(0, 5).map((u) => recommendForFinding(u));
      const blockers = onboarding.blockers.filter((b) => b.humanAction);
      if (!asks.length && !blockers.length) {
        return { state: onboarding.state, message: 'Nothing right now — everything I can establish on my own is configured, and no decision is waiting on you.', data: { onboarding }, actions: [] };
      }
      return {
        state: ASSISTANT_STATE.NEEDS_INPUT,
        message: composeNeeds(asks, blockers),
        data: { asks, blockers },
        actions: asks.map((a) => ({ id: 'confirm_decision', label: `Decide: ${a.subject}`, subject: a.subject })),
      };
    }

    case 'explain': {
      const target = resolveReference(message, unresolved);
      if (!target) {
        // No pending decision matches "why" — this is usually a real
        // question about the site's data ("why did clicks drop"), not an
        // onboarding one.
        const fallback = await tryDataFallback(ctx, message, conversationId, deps);
        if (fallback) return fallback;
        return { state: onboarding.state, message: 'There is no pending decision to explain right now.', data: {}, actions: [] };
      }
      const rec = recommendForFinding(target);
      return { state: onboarding.state, message: composeExplanation(rec), data: { recommendation: rec }, actions: [] };
    }

    case 'unsure': {
      const target = resolveReference(message, unresolved);
      if (!target) return { state: onboarding.state, message: 'Nothing is waiting on you, so there is nothing you need to be sure about.', data: {}, actions: [] };
      const rec = recommendForFinding(target);
      // Never forces a choice — explains, recommends, and leaves it open (§6).
      return {
        state: ASSISTANT_STATE.NEEDS_INPUT,
        message: `${composeExplanation(rec)}\n\nYou can leave this for now — it only blocks this one item, and everything else continues. I will not guess on your behalf.`,
        data: { recommendation: rec, deferred: true },
        actions: [],
      };
    }

    case 'confirm': {
      const target = resolveReference(message, unresolved);
      if (!target) return { state: onboarding.state, message: 'There is no pending decision to confirm.', data: {}, actions: [] };
      const result = await invokeCapability('confirm_decision', ctx, { findingId: target.id, accepted: true }, deps);
      if (!result.ok) return { state: onboarding.state, message: result.remedy || `I could not record that decision: ${result.error}.`, data: result, actions: [] };
      return {
        state: ASSISTANT_STATE.READY,
        message: `Recorded. "${target.subject}" is settled and I will not ask again — it is stored with the site's understanding, so future runs reuse it.`,
        data: result.data,
        actions: [],
      };
    }

    case 'run_discovery':
    case 'do_it': {
      // "Do it" means execute, not explain (§16).
      const result = await invokeCapability('run_discovery', ctx, {}, deps);
      if (!result.ok) {
        return { state: ASSISTANT_STATE.BLOCKED, message: result.remedy || `I cannot run discovery: ${result.error}.`, data: result, actions: [] };
      }
      if (result.data.ok === false) {
        return { state: ASSISTANT_STATE.BLOCKED, message: 'There is no repository connected to this site yet, so there is nothing for me to inspect.', data: result.data, actions: [] };
      }
      return { state: ASSISTANT_STATE.REVIEWING, message: composeDiscovery(result.data), data: result.data, actions: [] };
    }

    case 'run_remediation': {
      // Reuses the exact function the daily cron calls — not a second
      // implementation. Ends at open PRs; never merges (§9 — the human
      // merge gate is untouched by this session's changes end to end).
      const result = await invokeCapability('run_safe_remediation', ctx, {}, deps);
      if (!result.ok) return { state: onboarding.state, message: result.remedy || `I could not run remediation: ${result.error}.`, data: result, actions: [] };
      return { state: onboarding.state, message: composeRemediation(result.data), data: result.data, actions: [] };
    }

    case 'failures': {
      const result = await invokeCapability('get_failures', ctx, {}, deps);
      const failures = result.ok ? result.data : [];
      if (!failures.length) return { state: onboarding.state, message: 'No recent failures.', data: {}, actions: [] };
      const explained = failures.map((f) => ({ jobId: f.jobId, kind: f.kind, ...explainFailure(f.failure) }));
      return { state: onboarding.state, message: composeFailures(explained), data: { failures: explained }, actions: [] };
    }

    case 'agent_work': {
      const [agents, approvals, autonomy] = await Promise.all([
        invokeCapability('get_agent_status', ctx, {}, deps),
        invokeCapability('get_pending_approvals', ctx, {}, deps),
        invokeCapability('get_autonomy_summary', ctx, {}, deps),
      ]);
      return {
        state: onboarding.state,
        message: composeAgentWork(agents.ok ? agents.data : null, approvals.ok ? approvals.data : null, autonomy.ok ? autonomy.data : null),
        data: { agents: agents.data, approvals: approvals.data, autonomy: autonomy.data },
        actions: [],
      };
    }

    default: {
      const fallback = await tryDataFallback(ctx, message, conversationId, deps);
      if (fallback) return fallback;
      return {
        state: onboarding.state,
        message: ctx.role === 'platform_admin'
          ? `I can tell you how onboarding is going, what needs your decision, what the agents have been doing, or why something failed; run discovery and configure what I can prove; or ask about this site's traffic, findings, and forecasts.`
          : `I can tell you how onboarding is going, what needs your decision, what the agents have been doing, why something failed, or anything about this site's traffic and findings — and I can run discovery and configure what I can prove.`,
        data: { available: capabilitiesFor(ctx.role) },
        actions: [],
      };
    }
  }
}

// ---- composition ------------------------------------------------------
// Plain functions over structured results. No model call: the words are
// derived from the same data returned in `data`, so they cannot drift from it.

function composeStatus(site, onboarding, unresolved) {
  if (onboarding.state === ASSISTANT_STATE.BLOCKED && !onboarding.categories.length) {
    return onboarding.blockers[0]?.reason || 'Onboarding has not started.';
  }
  const ready = onboarding.categories.filter((c) => c.state === 'READY').map((c) => c.category);
  const parts = [`${onboarding.percentComplete}% complete for ${site.name || 'this site'}.`];
  if (ready.length) parts.push(`Configured and validated: ${ready.join(', ')}.`);
  if (unresolved.length) parts.push(`${unresolved.length} item${unresolved.length === 1 ? '' : 's'} need${unresolved.length === 1 ? 's' : ''} your decision.`);
  else parts.push('Nothing is waiting on you.');
  return parts.join(' ');
}

function composeNeeds(asks, blockers) {
  const lines = [`I need ${asks.length + blockers.length} thing(s) from you:`];
  asks.forEach((a, i) => {
    lines.push(`\n${i + 1}. ${a.subject}`);
    lines.push(`   Risk: ${a.risk}`);
    if (a.recommendation) lines.push(`   Recommendation: ${a.recommendation.label || a.recommendation.id}`);
    lines.push(`   Why I'm asking: ${a.whyAsking}`);
  });
  blockers.forEach((b, i) => {
    lines.push(`\n${asks.length + i + 1}. ${b.reason}`);
    lines.push(`   You need to: ${b.humanAction}`);
  });
  return lines.join('\n');
}

function composeExplanation(rec) {
  const lines = [`${rec.subject}`, '', rec.whyAsking, ''];
  if (rec.evidence?.length) {
    lines.push('What I found:');
    for (const e of rec.evidence.slice(0, 4)) lines.push(`  • ${e.detail}${e.source ? ` (${e.source})` : ''}`);
  }
  if (rec.recommendation) {
    lines.push('', `My recommendation: ${rec.recommendation.label || rec.recommendation.id}`);
    lines.push('I am waiting for your confirmation because getting this wrong would affect many pages at once.');
  } else {
    lines.push('', 'I do not have a strong enough basis to recommend one option, so I am not going to guess.');
  }
  return lines.join('\n');
}

function composeDiscovery(d) {
  const lines = [];
  if (d.framework) lines.push(`✓ Detected ${d.framework}`);
  if (d.pageTypes) lines.push(`✓ Found ${d.pageTypes} page famil${d.pageTypes === 1 ? 'y' : 'ies'}`);
  if (d.routesResolved) lines.push(`✓ Resolved ${d.routesResolved} routes from repository evidence`);
  lines.push(d.autoConfigured
    ? `✓ Configured and validated ${d.autoConfigured} mapping${d.autoConfigured === 1 ? '' : 's'} automatically`
    : '• Nothing new to configure — everything provable is already set up');
  for (const a of d.autoConfiguredDetail || []) lines.push(`    ${a.wrote}`);
  const needing = (d.summary || []).filter((s) => s.state === 'NEEDS_CONFIRMATION');
  if (needing.length) lines.push('', `${needing.length} categor${needing.length === 1 ? 'y needs' : 'ies need'} a decision from you: ${needing.map((n) => n.category).join(', ')}.`);
  return lines.join('\n');
}

function composeRemediation(r) {
  if (r.stoppedReason === 'disabled') {
    return "Autonomous remediation isn't enabled for this site, so I didn't run anything. Nothing was attempted or changed.";
  }
  if (r.stoppedReason === 'budget-exhausted') {
    return `Today's budget (${r.spentToday}/${r.dailyLimit}) is already used — nothing new attempted. It resumes tomorrow.`;
  }
  const lines = [`Ran the safe-remediation loop: ${r.shipped} shipped, ${r.failed} failed, ${r.refused} declined honestly, ${r.skipped} left for later.`];
  if (r.stoppedReason === 'circuit-breaker') lines.push('Stopped early — several failures in a row suggested a systemic problem rather than one-off issues. The rest stayed untouched and open, not lost.');
  if (r.stoppedReason === 'refusal-streak') lines.push("Stopped early — several items in a row couldn't be drafted honestly. That's the no-fabrication policy working, not a fault.");
  if (r.shipped) lines.push('Each shipped item ended at an open pull request — nothing merges without your review.');
  return lines.join('\n');
}

function composeFailures(explained) {
  return explained.map((f) => {
    if (!f.known) return `Job #${f.jobId}: ${f.headline}`;
    return [
      `Job #${f.jobId} (${f.kind}) — ${f.headline}`,
      `  Classification: ${f.classification}`,
      `  What it means: ${f.meaning}`,
      `  What I'll do: ${f.systemWillDo}`,
      `  What you need to do: ${f.youShouldDo}`,
      f.attempts > 1 ? `  Attempts: ${f.attempts}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function composeAgentWork(agents, approvals, autonomy) {
  const lines = ['Recent autonomous work:'];
  const recent = agents?.recent || [];
  lines.push(recent.length ? `  ✓ ${recent.length} agent run(s) recorded` : '  • No agent activity recorded yet');
  if (approvals) {
    lines.push(`  ⚠ ${approvals.actionable} recommendation(s) ready for approval`);
    if (approvals.blocked) lines.push(`  • ${approvals.blocked} blocked pending prerequisites`);
  }
  if (autonomy) {
    lines.push(`  ✓ ${autonomy.safeToAutoExecute.length} safe to auto-execute right now`);
    lines.push(`  ⚠ ${autonomy.needsHumanReview.length} need your review`);
  }
  lines.push('', 'Production merge still requires your approval — I prepare changes, I do not ship them.');
  return lines.join('\n');
}
