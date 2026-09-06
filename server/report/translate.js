import { query } from '../db.js';
import { callLLM } from '../llm.js';

// No cheap heuristic can reliably tell English apart from other Latin-alphabet
// languages with no accented characters (e.g. Indonesian, Malay) — exactly the
// queries this feature exists to catch — so every uncached query goes through
// the LLM once; the DB cache keyed by query text is what keeps repeat cost low.
export async function translateQuery(text) {
  const q = String(text || '').trim();
  if (!q) return { language: 'unknown', translation: '' };

  const cached = await query('SELECT language, translation FROM query_translations WHERE query = $1', [q]);
  if (cached.rows.length) return cached.rows[0];

  const system = 'Detect the language of this search query and give a short, literal English ' +
    'translation/interpretation. Reply with ONLY compact JSON, no markdown, no code fences: ' +
    '{"language": "...", "translation": "..."}';
  let result;
  try {
    const raw = await callLLM(system, q, { maxTokens: 100 });
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    result = { language: parsed.language || 'unknown', translation: parsed.translation || q };
  } catch {
    return { language: 'unknown', translation: q }; // don't cache a failure — allow retry
  }

  await query(
    `INSERT INTO query_translations (query, language, translation) VALUES ($1, $2, $3)
     ON CONFLICT (query) DO UPDATE SET language = EXCLUDED.language, translation = EXCLUDED.translation`,
    [q, result.language, result.translation]
  );
  return result;
}
