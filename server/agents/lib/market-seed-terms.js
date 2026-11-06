import { getProductCapabilities } from '../../store/data-analyst.js';
import { query } from '../../db.js';

// Where the market keyword set comes from. Market discovery costs money and its seeds decide what gets researched, so
// the terms must be things the business has actually said it sells — never an LLM's guess about the industry.
//
// Preference order, strongest evidence first (the same ladder describeTenantForRelevance already uses for judging a
// topic's relevance, kept deliberately consistent):
//   1. verified product capabilities  — a human approved these (store/data-analyst.js, kind 'capability')
//   2. site_profiles.main_topics_json — the profiler's own topics for this site
//   3. confirmed site_understanding   — facts about the site a human confirmed
// A site with none of these returns no terms, and the caller skips the paid call with the reason 'no_services_known'
// rather than researching a market nobody has described.

const MAX_TERMS = 12;

export async function resolveMarketServiceTerms(siteId, { deps = {} } = {}) {
  const capabilities = deps.getProductCapabilities || getProductCapabilities;
  const q = deps.query || query;

  const verified = await capabilities(siteId, 'verified').catch(() => []);
  const fromCapabilities = clean((verified || []).map((c) => c.name));
  if (fromCapabilities.length) return { terms: fromCapabilities.slice(0, MAX_TERMS), source: 'verified-capabilities', confidence: 'high' };

  const profile = await q('SELECT main_topics_json FROM site_profiles WHERE site_id = $1', [siteId]).catch(() => ({ rows: [] }));
  const topics = parseTopics(profile.rows?.[0]?.main_topics_json);
  if (topics.length) return { terms: topics.slice(0, MAX_TERMS), source: 'site-profile-topics', confidence: 'medium' };

  const understanding = await q(
    `SELECT subject, finding FROM site_understanding
      WHERE site_id = $1 AND status = 'confirmed' AND category IN ('offering', 'business', 'product', 'service')
      ORDER BY updated_at DESC LIMIT 20`,
    [siteId]
  ).catch(() => ({ rows: [] }));
  const fromUnderstanding = clean((understanding.rows || []).map((r) => r.subject));
  if (fromUnderstanding.length) return { terms: fromUnderstanding.slice(0, MAX_TERMS), source: 'site-understanding', confidence: 'medium' };

  return { terms: [], source: null, confidence: null };
}

// main_topics_json has been written by more than one producer over time, so accept the shapes that actually occur —
// an array of strings, an array of {topic|name|term}, or a JSON string of either — and ignore anything else rather
// than guessing at it.
function parseTopics(raw) {
  if (!raw) return [];
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return clean([value]); }
  }
  if (!Array.isArray(value)) return [];
  return clean(value.map((t) => (typeof t === 'string' ? t : t?.topic || t?.name || t?.term)));
}

function clean(values) {
  const out = [];
  for (const v of values) {
    const s = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
    // A single word under three characters carries no market meaning; a very long phrase is a sentence, not a service.
    if (s.length >= 3 && s.length <= 60 && !out.includes(s)) out.push(s);
  }
  return out;
}
