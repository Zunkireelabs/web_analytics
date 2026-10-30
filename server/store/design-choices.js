import { query } from '../db.js';

// design_choices (migration 215): fixes the agent could not fit into the client's design. See the migration for the
// life of a row. The agent creates them (createDesignChoice); a person picks (chooseDesignOption); the next scheduled
// run builds the picks (listChosenDesignChoices).

const COLS = 'id, finding_id, generator_id, draft_id, title, page_url, reason, attempts, options, chosen_option, status, created_at, chosen_at';

export async function listDesignChoices(siteId) {
  const { rows } = await query(
    `SELECT ${COLS} FROM design_choices WHERE site_id = $1 AND status IN ('needs_choice', 'chosen', 'building', 'withdrawn') ORDER BY created_at DESC`,
    [siteId]
  );
  return rows;
}

export async function getDesignChoice(siteId, id) {
  const { rows } = await query(`SELECT ${COLS} FROM design_choices WHERE site_id = $1 AND id = $2`, [siteId, id]);
  return rows[0] || null;
}

// What the agent calls when its repair loop gives up on a fix. One open row per idea: if there already is one, it is
// refreshed with the new attempts and options and put back to needs_choice (a withdrawn build comes back this way).
export async function createDesignChoice(siteId, { findingId, generatorId, draftId = null, title, pageUrl = null, reason = null, attempts = [], options }) {
  const { rows } = await query(
    `INSERT INTO design_choices (site_id, finding_id, generator_id, draft_id, title, page_url, reason, attempts, options)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (site_id, finding_id) DO UPDATE
       SET generator_id = EXCLUDED.generator_id, draft_id = EXCLUDED.draft_id, title = EXCLUDED.title, page_url = EXCLUDED.page_url,
           reason = EXCLUDED.reason, attempts = EXCLUDED.attempts, options = EXCLUDED.options,
           chosen_option = NULL, chosen_at = NULL, status = 'needs_choice', updated_at = now()
       WHERE design_choices.status IN ('needs_choice', 'withdrawn', 'shipped')
     RETURNING ${COLS}`,
    [siteId, findingId, generatorId, draftId, title, pageUrl, reason, JSON.stringify(attempts), JSON.stringify(options)]
  );
  if (rows[0]) return rows[0];
  // A person has already chosen (or the run is building it): keep their choice, do not reset it. A finished (shipped) one
  // may reopen, because the same finding can come back.
  return getDesignChoiceByFinding(siteId, findingId);
}

async function getDesignChoiceByFinding(siteId, findingId) {
  const { rows } = await query(`SELECT ${COLS} FROM design_choices WHERE site_id = $1 AND finding_id = $2`, [siteId, findingId]);
  return rows[0] || null;
}

export async function chooseDesignOption(siteId, id, optionKey, userId = null) {
  const { rows } = await query(
    `UPDATE design_choices SET chosen_option = $3, status = 'chosen', chosen_by = $4, chosen_at = now(), updated_at = now()
      WHERE site_id = $1 AND id = $2 AND status IN ('needs_choice', 'chosen', 'withdrawn') RETURNING ${COLS}`,
    [siteId, id, optionKey, userId]
  );
  return rows[0] || null;
}

// Taking a choice back puts it to needs_choice again; only possible before the run has started building it.
export async function clearDesignChoice(siteId, id) {
  const { rows } = await query(
    `UPDATE design_choices SET chosen_option = NULL, status = 'needs_choice', chosen_at = NULL, updated_at = now()
      WHERE site_id = $1 AND id = $2 AND status = 'chosen' RETURNING ${COLS}`,
    [siteId, id]
  );
  return rows[0] || null;
}

// What the next run builds.
export async function listChosenDesignChoices(siteId) {
  const { rows } = await query(
    "SELECT id, finding_id, generator_id, draft_id, chosen_option FROM design_choices WHERE site_id = $1 AND status = 'chosen' ORDER BY chosen_at",
    [siteId]
  );
  return rows;
}

// The run moves a choice along: chosen -> building -> shipped, or back to needs_choice when it still could not be built
// (so the person is asked again, with fresh attempts). Guarded by the status the run expects, so a choice a person has
// meanwhile taken back is never overwritten.
export async function markDesignChoiceStatus(siteId, id, to, from) {
  const { rows } = await query(
    `UPDATE design_choices SET status = $3, updated_at = now() WHERE site_id = $1 AND id = $2 AND status = ANY($4) RETURNING ${COLS}`,
    [siteId, id, to, Array.isArray(from) ? from : [from]]
  );
  return rows[0] || null;
}
