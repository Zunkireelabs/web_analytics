import { getLatestDesignAgentJob, DESIGN_PROFILE_JOB_KEY } from '../../store/execution-jobs.js';
import { isProfileUsable } from '../../design-agent/lib/design-profile.js';

// Deliberately NOT design-drift.js's own getDesignProfile/siteHasUsableDesignProfile
// — pulling that module in here would drag its full production import graph
// (store/admin/audit-log.js, agent-memory.js, design-agent/openhands-handler.js,
// ...) into every caller of what is otherwise a tiny, leaf-level onboarding
// check, including agents/lib/auto-remediation.js and
// scripts/repair-template-capability.js — both of which have their own
// heavily-mocked test suites that would then need to mock all of that too,
// for logic neither file actually touches. This 2-line duplication is the
// deliberate trade.
function siteHasUsableProfile(site) {
  return isProfileUsable(site?.url_file_map?.siteRoot?.designProfile || null);
}

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
// 'queued'/'executing' = still pending; 'completed'/'failed' = terminal, no
// longer pending — a FAILED analysis must not block repair forever, it just
// means the derivation itself didn't produce a profile, same as if none had
// ever been queued. And critically: NO job row at all is also not pending,
// so a site that predates this gate (or had auto_remediation_enabled granted
// by hand before this existed) is never newly blocked by a feature it never
// triggered.
export async function isOnboardingAnalysisPending(site, {
  hasUsableProfile = siteHasUsableProfile,
  latestProfileJob = getLatestDesignAgentJob,
} = {}) {
  if (hasUsableProfile(site)) return false;
  const job = await latestProfileJob(site.id, DESIGN_PROFILE_JOB_KEY);
  if (!job) return false;
  return job.status === 'queued' || job.status === 'executing';
}
