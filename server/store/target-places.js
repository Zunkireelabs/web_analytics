import { query } from '../db.js';
import { targetPlaces } from '../agents/lib/local-seo.js';

// The towns and cities a local client works in (migration 241). Normalised through the same function everything else
// reads with, so what is stored is exactly what will be used — no second opinion on what counts as a valid place.

export async function getTargetPlaces(siteId) {
  const { rows } = await query('SELECT target_places FROM sites WHERE id = $1', [siteId]);
  return rows[0] ? targetPlaces({ target_places: rows[0].target_places }) : null;
}

/**
 * Replace the declared places. `primary` is where the business is based; `nearby` are the others, in priority order.
 * A nearby list with no primary is refused: with nothing to put first there is no order to honour, and "the first one
 * you typed" would quietly become the home town.
 */
export async function setTargetPlaces(siteId, { primary, nearby = [] }) {
  const home = String(primary ?? '').trim();
  const others = (Array.isArray(nearby) ? nearby : []).map((n) => String(n ?? '').trim()).filter(Boolean);
  if (!home && others.length) throw new Error('Name the place you are based first; nearby places are ordered after it.');

  const cleaned = targetPlaces({
    target_places: [...(home ? [{ name: home, tier: 'primary' }] : []), ...others.map((name) => ({ name, tier: 'nearby' }))],
  });
  const { rows } = await query(
    'UPDATE sites SET target_places = $2::jsonb WHERE id = $1 RETURNING id',
    [siteId, JSON.stringify(cleaned)]
  );
  return rows[0] ? cleaned : null;
}
