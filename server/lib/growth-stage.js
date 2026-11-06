// The per-project growth programme: Days 1-30 Growth Acceleration, 31-60 Growth Expansion, 61+ Continuous Optimisation.
// The clock is sites.growth_started_at (migration 230): existing clients start at the deployment, new clients at creation.
//
// These are PRIORITISATION stages, not restrictions. The stage only adds a small, bounded amount to the existing ranking
// (agents/lib/growth-scoring.js), always far below one severity tier (STEP 1000), so a critical issue still outranks
// everything at every stage and the autonomy / approval gates (which never see the score) are unchanged.

export const STAGES = Object.freeze({
  acceleration: { id: 'acceleration', label: 'Growth Acceleration', from: 1, to: 30 },
  expansion: { id: 'expansion', label: 'Growth Expansion', from: 31, to: 60 },
  optimisation: { id: 'optimisation', label: 'Continuous Optimisation', from: 61, to: null },
});
export const ACCELERATION_DAYS = 30;
export const EXPANSION_END_DAY = 60;
const MS_DAY = 24 * 60 * 60 * 1000;

// Pure. Day 1 is the day the clock started. A missing or future start date is treated as Day 1 and flagged, never a crash:
// a project must never silently fall out of the programme.
export function growthStageFor(startedAt, now = new Date()) {
  const start = startedAt ? new Date(startedAt) : null;
  const valid = start && !Number.isNaN(start.getTime());
  const elapsed = valid ? Math.floor((now.getTime() - start.getTime()) / MS_DAY) : 0;
  const day = Math.max(1, elapsed + 1);
  const stage = day <= ACCELERATION_DAYS ? STAGES.acceleration : day <= EXPANSION_END_DAY ? STAGES.expansion : STAGES.optimisation;
  const nextAt = stage.to && valid ? new Date(start.getTime() + stage.to * MS_DAY) : null;
  return {
    stage: stage.id,
    label: stage.label,
    day,
    daysLeftInStage: stage.to ? stage.to - day + 1 : null,
    nextStage: stage.id === 'acceleration' ? 'expansion' : stage.id === 'expansion' ? 'optimisation' : null,
    nextStageAt: nextAt ? nextAt.toISOString() : null,
    startedAt: valid ? start.toISOString() : null,
    clock: valid ? 'ok' : 'missing-start-date',
  };
}

// Which kind of work each stage favours. Bounded: the largest value is far below STEP / 2.
export const STAGE_SWING = Object.freeze({
  acceleration: { 1: 150, 2: 120, 3: 60, 4: 0, 5: 0 },   // fix what blocks search, then the high-impact on-page work
  expansion: { 1: 60, 2: 60, 3: 150, 4: 100, 5: 0 },     // extend what already shows demand, add new content
  optimisation: { 1: 100, 2: 0, 3: 40, 4: 0, 5: 0 },     // keep technical health; declining pages get their own bonus below
});
export const DECLINE_STAGE_BONUS = Object.freeze({ acceleration: 0, expansion: 0, optimisation: 100 });

// Pure. growth: the object growthStageFor returns (or null = no stage known = no effect).
export function stageScore(growth, tier, { declining = false } = {}) {
  if (!growth || !growth.stage) return { score: 0, factors: [], basis: null };
  const table = STAGE_SWING[growth.stage];
  let add = table?.[tier] ?? 0;
  if (declining) add += DECLINE_STAGE_BONUS[growth.stage] ?? 0;
  const where = `${growth.label}, day ${growth.day}`;
  if (!add) return { score: 0, factors: [`growth stage: ${where}, no stage preference for this kind of work (+0)`], basis: null };
  return { score: add, factors: [`growth stage: ${where} favours this kind of work (+${add})`], basis: 'growth-stage' };
}

// Reads the clock. Never throws: a failed read returns null and the ranking is unchanged.
export async function loadGrowthStage(siteId, { deps = {}, now = new Date() } = {}) {
  try {
    const q = deps.query || (await import('../db.js')).query;
    const { rows } = await q(`SELECT growth_started_at FROM sites WHERE id = $1`, [siteId]);
    if (!rows[0]) return null;
    return growthStageFor(rows[0].growth_started_at, now);
  } catch (err) {
    console.warn(`[growth-stage] could not read the growth clock for site ${siteId}: ${err.message} — ranking is not stage-adjusted.`);
    return null;
  }
}

// Records stages a project has reached (one row per stage). Idempotent. Used by the daily learning update.
export async function recordStageEntry(siteId, growth, { deps = {} } = {}) {
  if (!growth?.stage) return false;
  const q = deps.query || (await import('../db.js')).query;
  const { rowCount } = await q(
    `INSERT INTO growth_stage_log (site_id, stage, day) VALUES ($1, $2, $3) ON CONFLICT (site_id, stage) DO NOTHING`,
    [siteId, growth.stage, growth.day]
  );
  return rowCount > 0;
}
