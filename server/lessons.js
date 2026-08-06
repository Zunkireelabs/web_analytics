import { query } from './db.js';

// Read side of fix_lessons (see migration 086) — every LLM-backed generator
// call goes through callLLM/callLLMForJson (llm.js), which calls
// getLessons() itself when passed a generatorId, so this module's only job
// is the lookup + a short cache (lessons change rarely; a DB round trip on
// every single generator call would be pure overhead).
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key -> { rows, expiresAt }

function cacheKey(generatorId, siteId) {
  return `${generatorId || '*'}:${siteId ?? '*'}`;
}

export async function getLessons(generatorId, siteId) {
  const key = cacheKey(generatorId, siteId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.rows;

  const { rows } = await query(
    `SELECT title, lesson FROM fix_lessons
     WHERE active
       AND (generator_id IS NULL OR generator_id = $1)
       AND (site_id IS NULL OR site_id = $2)
     ORDER BY created_at ASC`,
    [generatorId || null, siteId ?? null],
  );
  cache.set(key, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
  return rows;
}

// Write side — called by an admin/agent recording a real fix (see
// server/scripts/add-fix-lesson.js), or by fix-verification.js when a
// previously-applied fix is found to have regressed (source: 'regression').
export async function addLesson({ generatorId = null, siteId = null, title, lesson, source = 'manual' }) {
  if (!title || !lesson) throw new Error('title and lesson are required');
  const { rows } = await query(
    `INSERT INTO fix_lessons (generator_id, site_id, title, lesson, source)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [generatorId, siteId, title, lesson, source],
  );
  cache.clear();
  return rows[0].id;
}
