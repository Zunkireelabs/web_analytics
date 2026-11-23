import { staticAnswer } from './questions.js';
import { invokeCapability, capabilitiesFor } from './capabilities.js';
import { classifyApproval, pickPullRequests } from './approval-chat.js';
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
  // First: "any PR today?", "what got merged yesterday", "PRs this week". Answered straight from the records.
  { id: 'prs', patterns: [/\b(prs?|pull[- ]?requests?)\b/i, /\bmerged?\b/i, /\bdeploy(ed|ments?|s)?\b/i] },
  { id: 'week', patterns: [/\b(what|anything)\b.*\b(changed|went live|shipped|published)\b/i, /\b(this|last) week\b/i, /\bwhat('s| has| have)? been (done|changed|published)\b/i] },
  { id: 'findings', patterns: [/\b(what|show|list|give)\b.*\b(found|find|findings|waiting|pending|to fix|needs? (me|my|you)|everything|broken|issues?)\b/i, /\bwhat('s| is) (broken|waiting)\b/i, /\b(full|complete) list\b/i] },
  { id: 'status', patterns: [/\bhow('s| is)?\b.*\b(onboarding|going|progress|setup)\b/i, /\bstatus\b/i, /\bhow far\b/i] },
  { id: 'needs_from_me', patterns: [/what do you need/i, /\bneed from me\b/i, /what.*\b(should|do)\b.*\bi\b.*\bdo\b/i, /\bblock(ing|ers?)\b/i] },
  { id: 'explain', patterns: [/\bwhy\b/i, /\bexplain\b/i, /what does .* mean/i] },
  { id: 'confirm', patterns: [/\b(use|choose|pick|select)\b.*\b(first|second|option|a|b|one)\b/i, /\bconfirm\b/i, /\byes,? (use|go|do)\b/i] },
  { id: 'run_discovery', patterns: [/\b(run|start|begin|redo|refresh)\b.*\b(discovery|onboarding|scan|inspect)\b/i, /\bconfigure the\b/i, /\bset ?up\b/i] },
  { id: 'run_remediation', patterns: [/\b(ship|fix|remediat\w*)\b.*\b(safe|what.?s safe|today|now)\b/i, /\brun (safe )?remediation\b/i, /\bfix everything safe\b/i] },
  { id: 'do_it', patterns: [/^\s*(do it|go ahead|proceed|continue|carry on)\s*[.!]?\s*$/i] },
  { id: 'failures', patterns: [/\b(fail(ed|ure)s?|error|broke(n)?|not working|why did .* fail)\b/i] },
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
  // The streaming chat (chat-stream.js) answers these itself, live, with tools. It asks handleMessage only for the replies that
  // need no AI, and this marker says "not one of those" without paying for the slow copilot path first.
  if (deps?.deferAi) return { deferred: true };
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
  // The agent has told the person a pull request is ready; they answer in their own words. Checked first, but only when something really
  // is waiting, so an ordinary "ok" or "go ahead" with nothing pending still means what it always meant.
  const approval = classifyApproval(message);
  if (approval !== 'none') {
    const needs = await invokeCapability('get_needs_you', ctx, {}, deps);
    const pending = (needs.ok ? needs.data.items : []).filter((i) => i.prNumber);
    if (pending.length) return handleApprovalReply({ ctx, message, approval, pending, deps });
  }

  // A plain-English question ("what is AEO?", "what happens when I approve?") has one fixed answer for every client and
  // needs no site data, so it is answered before anything is read.
  const fixed = staticAnswer(message);
  if (fixed) return { state: ASSISTANT_STATE.READY, message: fixed, data: { fixed: true }, actions: [] };

  const intent = classifyIntent(message);

  // Factual questions with an exact answer in the database skip everything below (onboarding reads, the AI path):
  // one capability, a few indexed queries, a reply composed from the rows. Milliseconds, and never a guess.
  if (intent === 'prs') {
    const result = await invokeCapability('get_pr_activity', ctx, { period: periodFromMessage(message) }, deps)
      .catch((err) => { console.warn('[assistant] get_pr_activity failed:', err.message); return { ok: false }; });
    if (result.ok) return { state: ASSISTANT_STATE.READY, message: composePrs(result.data), data: result.data, actions: [] };
    return { state: ASSISTANT_STATE.FAILED, message: 'I could not read the pull request records just now. Please try again in a moment.', data: {}, actions: [] };
  }

  // Two independent reads — run together, not one after the other.
  const [status, unresolvedResult] = await Promise.all([
    invokeCapability('get_onboarding_status', ctx, {}, deps),
    invokeCapability('list_unresolved_decisions', ctx, {}, deps),
  ]);
  if (!status.ok) return { state: ASSISTANT_STATE.FAILED, message: status.remedy || 'Unable to read onboarding status.', data: status, actions: [] };

  const onboarding = deriveOnboardingState({
    categories: status.data.categories,
    repoConnected: status.data.site.repoConnected,
  });

  const unresolved = unresolvedResult.ok ? unresolvedResult.data : [];

  switch (intent) {
    case 'week': {
      const result = await invokeCapability('get_week_summary', ctx, {}, deps);
      return { state: onboarding.state, message: composeWeek(result.ok ? result.data : { total: 0, byType: [] }), data: result.data || {}, actions: [] };
    }

    case 'findings': {
      const result = await invokeCapability('get_needs_you', ctx, {}, deps);
      const items = result.ok ? result.data.items : [];
      return { state: onboarding.state, message: composeNeedsYou(items), data: { items }, actions: items.flatMap((i) => i.actions || []).slice(0, 6) };
    }

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

async function handleApprovalReply({ ctx, message, approval, pending, deps }) {
  const list = pending.map((p) => `#${p.prNumber}`).join(', ');
  if (approval === 'decline') {
    return { state: ASSISTANT_STATE.READY, message: `Okay, I'll leave ${pending.length === 1 ? `pull request ${list}` : `those (${list})`} open and merge nothing. Tell me when you want it merged, or what you'd like changed.`, data: { pending: list }, actions: [] };
  }
  const { prs, ambiguous } = pickPullRequests(message, pending);
  if (approval === 'unclear' || (approval === 'approve' && !prs.length)) {
    const what = pending.map((p) => `#${p.prNumber}: ${p.detail.split('. Tell me')[0]}`).join('\n');
    return {
      state: ASSISTANT_STATE.NEEDS_INPUT,
      message: ambiguous && approval === 'approve'
        ? `${pending.length} pull requests are waiting (${list}). Which one should I merge into stage? You can name it, or say "all".\n${what}`
        : `I haven't merged anything yet. Do you want me to merge ${pending.length === 1 ? `pull request ${list}` : `one of these (${list})`} into stage? Say "go ahead" to merge it, or tell me what you'd like changed. (If you meant something else, just ask.)\n${what}`,
      data: { pending: list }, actions: pending.map((p) => ({ id: 'merge_stage_pr', label: `Go ahead with #${p.prNumber}`, pr: p.prNumber })),
    };
  }
  const lines = []; let merged = 0;
  for (const n of prs) {
    const r = await invokeCapability('merge_stage_pr', ctx, { prNumber: n }, deps);
    const out = r.ok ? r.data : r;
    if (r.ok && out.ok) { merged += 1; lines.push(`Merged #${n} into ${out.base}${out.siteName ? ` on ${out.siteName}` : ''}.${out.promotion?.opened ? ` I opened the pull request to main (#${out.promotion.opened.number}) — that one you merge yourself.` : ' I will open the pull request to main as soon as stage is ready — you merge that one yourself.'}`); }
    else lines.push(`I did not merge #${n}: ${out.message || r.remedy || out.reason || 'it was refused'}. It stays open.`);
  }
  return { state: merged ? ASSISTANT_STATE.READY : ASSISTANT_STATE.BLOCKED, message: lines.join('\n'), data: { prs, merged }, actions: [] };
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
  const SKIP_TEXT = {
    'credential-locked': 'This project was skipped: another project sharing its GitHub credential was shipping at the time. It is tried again on the next run.',
    'site-locked': 'This project was skipped: another process held its shipping lock. It is tried again on the next run.',
    'window-closed': 'This project was not reached: the morning shipping window closed first. The hourly catch-up picks it up.',
    'global-ceiling-reached': 'This project was not reached: the platform-wide daily ceiling was already used.',
    'timed-out': "This project's run exceeded its time limit and was left behind so other projects could run.",
    'run-error': 'This project\'s run failed before it could start shipping. See the run record for the error.',
  };
  if (SKIP_TEXT[r.stoppedReason]) return `Nothing ran: ${SKIP_TEXT[r.stoppedReason]}`;
  const lines = [`Ran the safe-remediation loop: ${r.shipped} shipped, ${r.failed} failed, ${r.refused} declined honestly, ${r.skipped} left for later.`];
  if (r.stoppedReason === 'circuit-breaker') lines.push('Stopped early — several failures in a row suggested a systemic problem rather than one-off issues. The rest stayed untouched and open, not lost.');
  if (r.stoppedReason === 'refusal-streak') lines.push("Stopped early — several items in a row couldn't be drafted honestly. That's the no-fabrication policy working, not a fault.");
  if (r.selection?.needsInput) lines.push(`${r.selection.needsInput} item(s) are waiting for something only you or the client can supply; each says exactly what. They are not retried until it changes.`);
  if (r.selection?.quarantineNotes?.length) lines.push(`${r.selection.quarantineNotes.length} generator(s) were set aside for this run after repeating the same refusal or failure; everything else carried on.`);
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

// The full list of what is waiting on a person, grouped, in plain words. Built from data, no model call.
const NEEDS_YOU_GROUPS = [['approval', 'Waiting for your approval'], ['issue', 'Issues I found'], ['decision', 'Decisions I need from you']];
export function composeNeedsYou(items) {
  if (!items?.length) return 'Nothing is waiting on you right now. No approvals, no issues and no open decisions.';
  const lines = [`${items.length} ${items.length === 1 ? 'thing is' : 'things are'} waiting on you:`];
  const overdue = items.filter((i) => i.overdue);
  if (overdue.length) lines.push(`${overdue.length === items.length ? 'All of them have' : `${overdue.length} of them have`} been waiting two days or more — I'd start there.`);
  for (const [kind, heading] of NEEDS_YOU_GROUPS) {
    const group = items.filter((i) => i.kind === kind);
    if (!group.length) continue;
    lines.push('', `${heading}:`);
    for (const i of group) lines.push(`- ${i.title}${i.ageDays >= 1 ? ` (${i.ageDays}d)` : ''}${i.detail ? `: ${i.detail}` : ''}`);
  }
  return lines.join('\n');
}

// What went live in the last 7 days, in plain words. Only real counts from the drafts that reached "implemented".
export function composeWeek({ total, byType }) {
  if (!total) return 'Nothing has gone live on your site in the last 7 days. Anything waiting on you is in the Action Center.';
  const parts = byType.map((t) => `${t.count} ${t.type.replace(/-/g, ' ')}`).join(', ');
  return `${total} ${total === 1 ? 'change' : 'changes'} went live in the last 7 days: ${parts}.`;
}

// "yesterday" / "this week" / anything else = today.
export function periodFromMessage(message) {
  const t = String(message || '').toLowerCase();
  if (/\byesterday\b/.test(t)) return 'yesterday';
  if (/\b(this|last|past) week\b|\b7 days\b|\bweekly\b|\bthis week\b/.test(t)) return 'week';
  return 'today';
}

// Plain words from get_pr_activity's rows. No model call; every number and link comes from the records.
export function composePrs(d) {
  const when = { today: 'today', yesterday: 'yesterday', week: 'in the last 7 days' }[d.period] || 'today';
  const label = (pr) => (pr.number ? `#${pr.number}` : 'a pull request');
  const link = (pr) => (pr.url ? ` — ${pr.url}` : '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const lines = [];

  if (!d.opened.length && !d.merged.length) {
    lines.push(`No pull request was opened or merged ${when}.`);
  } else {
    lines.push(`${when[0].toUpperCase()}${when.slice(1)}: ${plural(d.opened.length, 'pull request', 'pull requests')} opened, ${d.merged.length} merged.`);
    for (const pr of d.opened) {
      const what = pr.fixes ? ` (${plural(pr.fixes, 'fix', 'fixes')}${pr.types ? `: ${pr.types}` : ''})` : '';
      lines.push(`- Opened ${label(pr)}${what}${pr.state ? `, now ${pr.state}` : ''}${link(pr)}`);
    }
    for (const pr of d.merged) lines.push(`- Merged ${label(pr)}${link(pr)}`);
  }

  if (d.open.length) {
    lines.push('', `Open right now, waiting for review or merge: ${plural(d.open.length, 'pull request', 'pull requests')}.`);
    for (const pr of d.open.slice(0, 5)) {
      const days = pr.since ? Math.floor((Date.now() - new Date(pr.since).getTime()) / 86_400_000) : null;
      lines.push(`- ${label(pr)} (${plural(pr.fixes, 'fix', 'fixes')}${days != null ? `, ${days < 1 ? 'since today' : `${days}d old`}` : ''})${link(pr)}`);
    }
    if (d.open.length > 5) lines.push(`- …and ${d.open.length - 5} more.`);
  } else {
    lines.push('', 'No pull request is open right now.');
  }
  if (d.timeZone && d.period !== 'week') lines.push(`(Days are counted in this project's time zone, ${d.timeZone}.)`);
  return lines.join('\n');
}
