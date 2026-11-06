// Phase 5: the "UPDATE LEARNING" tail of the existing daily lifecycle. No new cron system - cron.js calls these from the
// lanes it already runs (the morning pass and the hourly impact sweep).
//
// What updates what, and only on reliable evidence:
//   project memory      - snapshotProjectMemory records a new version only when a section's content really changed, so
//                         calling it often is safe; a failing section is skipped, never recorded as empty.
//   behaviour learning  - derived live from drafts / deployments / fix_impact on every read, so there is nothing to write:
//                         it "updates" the moment an outcome row is measured. Not duplicated here on purpose.
//   industry knowledge  - re-evaluated from MEASURED outcomes only (impact-inconclusive and insufficient-data never vote),
//                         with the cross-workspace thresholds in lib/industry-intelligence.js deciding promotion.
//
// Every function is best-effort and per-site isolated: one failing project never stops another, and nothing here can
// block shipping. Nothing here marks work deployed or improved; that stays with the PR poll, deployment gate and
// fix-impact measurement.

export const MEASURED_STATUS = 'measured';

// Pure: the distinct site ids behind newly MEASURED impact rows. 'insufficient-data' / null results are not a learning
// event, so they trigger nothing.
export function sitesWithNewOutcomes(results) {
  const ids = new Set();
  for (const r of results || []) {
    if (r && r.status === MEASURED_STATUS && r.site_id != null) ids.add(Number(r.site_id));
  }
  return [...ids];
}

export async function updateProjectMemoryForSites(siteIds, { reason = 'cron', deps = {} } = {}) {
  const snapshot = deps.snapshotProjectMemory || (await import('./project-memory.js')).snapshotProjectMemory;
  const out = { sites: 0, changed: 0, failed: 0 };
  for (const siteId of siteIds || []) {
    try {
      const r = await snapshot(siteId, { reason });
      out.sites += 1;
      out.changed += r?.changed?.length || 0;
    } catch (err) {
      out.failed += 1;
      console.error(`[learning-cycle] project memory snapshot failed for site ${siteId}:`, err.message);
    }
  }
  return out;
}

// Daily: every connected project's memory, so a change that happened outside any outcome event (design profile
// rescan, repo connected, goals edited) is still recorded.
export async function updateProjectMemoryForAllSites({ deps = {} } = {}) {
  const list = deps.listConnectedSites || (await import('../job.js')).listConnectedSites;
  let sites = [];
  try { sites = await list(); } catch (err) { console.error('[learning-cycle] could not list sites:', err.message); return { sites: 0, changed: 0, failed: 0, siteIds: [], sites_: [] }; }
  const siteIds = sites.map((s) => s.id ?? s.site_id);
  return { ...(await updateProjectMemoryForSites(siteIds, { reason: 'cron', deps })), siteIds, sites_: sites };
}

// Records each project's growth stage the first time it reaches it (growth_stage_log), so a project's journey through the
// 30 / 30 / ongoing programme is visible and auditable. Idempotent; one failing project never stops the others.
export async function recordGrowthStagesForSites(siteIds, { deps = {} } = {}) {
  const load = deps.loadGrowthStage || (await import('./growth-stage.js')).loadGrowthStage;
  const record = deps.recordStageEntry || (await import('./growth-stage.js')).recordStageEntry;
  const out = { checked: 0, entered: [], failed: 0 };
  for (const siteId of siteIds || []) {
    try {
      const g = await load(siteId);
      if (!g) continue;
      out.checked += 1;
      if (await record(siteId, g)) {
        out.entered.push({ siteId, stage: g.stage, day: g.day });
        console.log(`[growth] site ${siteId} entered ${g.label} (day ${g.day})`);
      }
    } catch (err) {
      out.failed += 1;
      console.error(`[learning-cycle] growth stage record failed for site ${siteId}:`, err.message);
    }
  }
  return out;
}

// CAPTURE BASELINE for connected projects that never completed one (clients that predate the baseline flow, or whose first
// attempt failed). Uses the existing locked baseline sequence (routes/clients.js), at most `limit` per run so a large backlog
// is worked through over several days instead of in one burst. Without a baseline "measure results against the baseline" has
// nothing to measure against.
export const BASELINES_PER_RUN = 3;
export async function ensureBaselines(sites, { limit = BASELINES_PER_RUN, deps = {} } = {}) {
  const missing = (sites || []).filter((s) => !s.onboarded_at);
  const out = { missing: missing.length, attempted: 0, ok: 0, failed: 0 };
  if (!missing.length) return out;
  const run = deps.runBaselineSequence || (await import('../routes/clients.js')).runBaselineSequence;
  for (const site of missing.slice(0, limit)) {
    out.attempted += 1;
    try {
      await run(site.id, site);
      out.ok += 1;
      console.log(`[learning-cycle] baseline captured for site ${site.id}`);
    } catch (err) {
      out.failed += 1;
      console.error(`[learning-cycle] baseline capture failed for site ${site.id} (will retry next run):`, err.message);
    }
  }
  return out;
}

export async function promoteIndustryKnowledge({ deps = {} } = {}) {
  const refresh = deps.refreshIndustryKnowledge || (await import('./industry-intelligence.js')).refreshIndustryKnowledge;
  try {
    return await refresh();
  } catch (err) {
    console.error('[learning-cycle] industry knowledge refresh failed:', err.message);
    return null;
  }
}

// After the hourly impact sweep: only projects that just got a real measurement, then the industry re-evaluation if any did.
export async function runLearningUpdateAfterOutcomes(results, { deps = {} } = {}) {
  const siteIds = sitesWithNewOutcomes(results);
  if (!siteIds.length) return { sites: 0, changed: 0, failed: 0, industry: null };
  const memory = await updateProjectMemoryForSites(siteIds, { reason: 'cron', deps });
  const industry = await promoteIndustryKnowledge({ deps });
  return { ...memory, industry };
}

// End of the morning pass.
export async function runDailyLearningUpdate({ deps = {} } = {}) {
  const { sites_: sites, ...memory } = await updateProjectMemoryForAllSites({ deps });
  const baselines = await ensureBaselines(sites, { deps });
  const industry = await promoteIndustryKnowledge({ deps });
  const growth = memory.siteIds ? await recordGrowthStagesForSites(memory.siteIds, { deps }) : null;
  return { ...memory, industry, growth, baselines };
}
