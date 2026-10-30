import { query } from '../db.js';

// content_picks (migration 213): one row per content idea a person has chosen an option for. Saving is the approval;
// the scheduled run reads the 'saved' rows (listSavedPicks) and builds them. See the migration for the statuses.

export async function listContentPicks(siteId) {
  const { rows } = await query(
    'SELECT finding_id, generator_id, option_key, status, chosen_at FROM content_picks WHERE site_id = $1 ORDER BY chosen_at DESC',
    [siteId]
  );
  return rows;
}

// Choosing again replaces the earlier choice and puts it back to 'saved' so the next run builds the new one.
export async function saveContentPick(siteId, { findingId, generatorId, optionKey, userId = null }) {
  const { rows } = await query(
    `INSERT INTO content_picks (site_id, finding_id, generator_id, option_key, chosen_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id, finding_id) DO UPDATE
       SET generator_id = EXCLUDED.generator_id, option_key = EXCLUDED.option_key, chosen_by = EXCLUDED.chosen_by,
           status = 'saved', chosen_at = now(), updated_at = now()
     RETURNING finding_id, generator_id, option_key, status, chosen_at`,
    [siteId, findingId, generatorId, optionKey, userId]
  );
  return rows[0];
}

// Only a pick nobody has started building can be taken back; once the run has it, it is not the person's to undo here.
export async function clearContentPick(siteId, findingId) {
  const { rowCount } = await query(
    "DELETE FROM content_picks WHERE site_id = $1 AND finding_id = $2 AND status IN ('saved', 'withdrawn')",
    [siteId, findingId]
  );
  return rowCount > 0;
}

// What the next run builds.
export async function listSavedPicks(siteId) {
  const { rows } = await query(
    "SELECT finding_id, generator_id, option_key FROM content_picks WHERE site_id = $1 AND status = 'saved' ORDER BY chosen_at",
    [siteId]
  );
  return rows;
}

// The run moves a pick along: saved -> building -> shipped, or back to saved (try again next run) or withdrawn (it could
// not be built; the person is asked to pick again). Guarded so a pick a person has since changed is never overwritten:
// the update only applies from the status the run expects.
export async function setPickStatus(siteId, findingId, to, from) {
  const { rows } = await query(
    'UPDATE content_picks SET status = $3, updated_at = now() WHERE site_id = $1 AND finding_id = $2 AND status = ANY($4) RETURNING finding_id, status',
    [siteId, findingId, to, Array.isArray(from) ? from : [from]]
  );
  return rows[0] || null;
}

// ---- once a day ----------------------------------------------------------------------------------------------------
// Approving only saves. The daily run builds, and it claims the day (sites.picks_built_on, migration 216) the first
// time it runs, so approvals made after that run wait for the next day's run rather than adding a second commit today.
// Atomic: of two runs that start together (the morning run and the catch-up guard), exactly one gets the day.
export async function claimPickDay(siteId, day) {
  const { rowCount } = await query('UPDATE sites SET picks_built_on = $2::date WHERE id = $1 AND picks_built_on IS DISTINCT FROM $2::date', [siteId, day]);
  return rowCount > 0;
}

export async function getPickDay(siteId) {
  const { rows } = await query("SELECT to_char(picks_built_on, 'YYYY-MM-DD') AS day FROM sites WHERE id = $1", [siteId]);
  return rows[0]?.day || null;
}

// A run that died half-way leaves picks 'building' (and design choices 'building') forever. Anything stuck that long goes
// back to waiting, so tomorrow's run picks it up instead of it being lost.
export async function releaseStuckBuilding(siteId, hours = 6) {
  const a = await query("UPDATE content_picks SET status = 'saved', updated_at = now() WHERE site_id = $1 AND status = 'building' AND updated_at < now() - ($2 || ' hours')::interval", [siteId, String(hours)]);
  const b = await query("UPDATE design_choices SET status = 'chosen', updated_at = now() WHERE site_id = $1 AND status = 'building' AND updated_at < now() - ($2 || ' hours')::interval", [siteId, String(hours)]);
  return a.rowCount + b.rowCount;
}
