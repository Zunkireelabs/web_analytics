import { getLatestDesignAgentJob, createDesignProfileJob, DESIGN_PROFILE_JOB_KEY } from '../../store/execution-jobs.js';
import { isProfileUsable } from '../../design-agent/lib/design-profile.js';

// Deliberately NOT design-drift.js's own getDesignProfile/siteHasUsableDesignProfile/
// sitePageUrl — pulling that module in here would drag its full production
// import graph (store/admin/audit-log.js, agent-memory.js,
// design-agent/openhands-handler.js, ...) into every caller of what is
// otherwise a tiny, leaf-level onboarding check, including
// agents/lib/auto-remediation.js and scripts/repair-template-capability.js —
// both of which have their own heavily-mocked test suites that would then
// need to mock all of that too, for logic neither file actually touches.
// This small duplication is the deliberate trade.
function siteHasUsableProfile(site) {
  return isProfileUsable(site?.url_file_map?.siteRoot?.designProfile || null);
}

function sitePageUrl(site) {
  const domain = site?.website_domain || site?.gsc_property?.replace(/^sc-domain:/, '');
  if (!domain) return null;
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

// How long a site's very FIRST design-profile derivation is allowed to stay
// in flight before this gate stops waiting on it. Without this, a stuck or
// permanently-failing-to-finish job (worker crash mid-run, a job that never
// gets claimed) would block a brand-new tenant from ever shipping a single
// autonomous fix — its own outage-class bug, symmetric to the one this gate
// exists to prevent. 48h comfortably covers the worker's normal cadence
// (real Playwright capture + LLM call, occasionally retried) while still
// bounding the wait to "a couple of days," not "forever." Same
// env-override-with-default pattern as DESIGN_AGENT_WAIT_MS/
// DESIGN_DRIFT_FETCH_TIMEOUT_MS (design-drift.js) and STALE_EXECUTING_MS
// (this file's own module) — never a bare constant for a wall-clock bound
// like this.
export const FIRST_DESIGN_PROFILE_TIMEOUT_MS = Number(process.env.FIRST_DESIGN_PROFILE_TIMEOUT_MS) || 48 * 60 * 60 * 1000;

// The two-stage onboarding gate: whether this site's initial whole-site
// analysis (the DESIGN_PROFILE_JOB_KEY job job.js's connect-repo-triggered
// queueDesignAgentDerivationForSite queues) is still in flight. Callers that
// actually EDIT the client's real repo — repair-template-capability.js's
// live architectural-gap branch, agents/lib/auto-remediation.js's PR-opening
// loop — must wait for this to go false before running, so a brand-new
// tenant's onboarding stays "analyze only" for however many cron passes it
// takes, and self-healing begins automatically the first pass that finds the
// analysis done. Callers that only ever write to OUR OWN DB (autoHealFileMapping,
// autoHealNewContentTarget, capability *detection*) are NOT gated on this —
// they carry no repo blast radius and are themselves part of "understand
// the repo's structure/mappings," not the repair work being deferred.
//
// A site that already has a usable profile is trivially not pending — no DB
// call needed. Otherwise this looks at the whole-site job's own row:
// 'completed'/'failed' = terminal, no longer pending — a FAILED analysis
// must not block repair forever, it just means the derivation itself didn't
// produce a profile.
//
// 'queued'/'executing' = pending, UNLESS it has been sitting in that state
// longer than FIRST_DESIGN_PROFILE_TIMEOUT_MS — a job a worker never claims,
// or crashes mid-run without marking itself failed, must not block this site
// forever either. Past the timeout this logs and falls through to "not
// pending" so shipping resumes without a profile, same as any other site
// whose derivation simply never succeeded.
//
// NO job row at all used to also mean "not pending" outright, so a site that
// predates this gate was never newly blocked by a feature it never
// triggered. That silently left the true gap this whole gate exists to
// close: a repo-connect onboarding flow whose enqueue step
// (queueDesignProfileDerivationForOnboarding) failed, or an old site from
// before that step existed, would ship its first fixes with zero
// design-baseline context forever, with nothing in flight to ever end it.
// Now a missing job triggers the FIRST derivation right here and reports
// pending — the same timeout above still applies (it starts from the
// created_at this call just produced), so this can only ever cost one cron
// pass, never an indefinite block.
export async function isOnboardingAnalysisPending(site, {
  hasUsableProfile = siteHasUsableProfile,
  latestProfileJob = getLatestDesignAgentJob,
  enqueueProfileJob = createDesignProfileJob,
  resolvePageUrl = sitePageUrl,
  now = () => Date.now(),
  timeoutMs = FIRST_DESIGN_PROFILE_TIMEOUT_MS,
} = {}) {
  if (hasUsableProfile(site)) return false;
  const job = await latestProfileJob(site.id, DESIGN_PROFILE_JOB_KEY);
  if (!job) {
    try {
      await enqueueProfileJob(site.id, { requestedBy: null, pageUrl: resolvePageUrl(site) });
    } catch (err) {
      console.error(`[onboarding-readiness] could not queue first design-profile derivation for site ${site.id}:`, err.message);
    }
    return true;
  }
  if (job.status !== 'queued' && job.status !== 'executing') return false;

  const queuedAt = job.created_at ? Date.parse(job.created_at) : NaN;
  if (Number.isFinite(queuedAt) && now() - queuedAt > timeoutMs) {
    console.warn(`[onboarding-readiness] site ${site.id}: first design-profile derivation has been pending for over ${timeoutMs}ms — shipping without a profile rather than blocking indefinitely.`);
    return false;
  }
  return true;
}
