// Pure shaping for the AI visibility page: which tracked prompts an AI engine names this
// company for (seen), which it does not (missing), and the phrases the missing ones
// suggest adding to pages. No DB, no LLM — everything here is derived from real
// ai_prompt_runs rows (mentioned is already a verified JS match, see ai-recommendation.js).

export const CHECK_WINDOW = 6; // "seen in X of the last 6 checks"

// A leading question/ranking stem carries no topic ("how to", "best", "what is the") —
// the phrase worth putting on a page is what is left.
const STEM = /^(what|which|who|where|why|how)(\s+(is|are|do|does|can|to|should|much|many))*(\s+(the|a|an))?\s+/i;
const RANK = /^(the\s+)?(best|top|good|great|cheap|cheapest|affordable|leading|recommended)\s+/i;
const MAX_WORDS = 6;

export function keyPhrase(promptText) {
  let t = String(promptText || '').toLowerCase().replace(/[“”"?!.]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) t = t.replace(STEM, '').replace(RANK, '');
  const words = t.split(' ').filter(Boolean).slice(0, MAX_WORDS);
  return words.length >= 2 ? words.join(' ') : '';
}

const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

// Best existing page for a phrase by shared words with the page path; null when nothing
// overlaps, which the page shows as "new page".
export function bestPageFor(phrase, pages = []) {
  const want = tokens(phrase);
  let best = null, bestScore = 0;
  for (const page of pages) {
    let path = page;
    try { path = new URL(page).pathname; } catch { /* already a path */ }
    const have = tokens(path);
    let score = 0;
    for (const w of want) if (have.has(w)) score++;
    if (score > bestScore) { best = path; bestScore = score; }
  }
  return best;
}

export function buildBoard({ prompts, runs, pages = [] }) {
  const byPrompt = new Map();
  for (const r of runs) {
    if (!byPrompt.has(r.prompt_id)) byPrompt.set(r.prompt_id, []);
    byPrompt.get(r.prompt_id).push(r);
  }

  const seen = [];
  const missing = [];
  for (const p of prompts) {
    const all = byPrompt.get(p.id) || [];
    if (!all.length) continue; // never checked yet — nothing honest to show
    // Distinct check dates, newest first, capped to the window.
    const dates = [...new Set(all.map((r) => String(r.run_date).slice(0, 10)))].slice(0, CHECK_WINDOW);
    const inWindow = all.filter((r) => dates.includes(String(r.run_date).slice(0, 10)));
    const hitDates = new Set(inWindow.filter((r) => r.mentioned).map((r) => String(r.run_date).slice(0, 10)));
    const latestRuns = all.filter((r) => String(r.run_date).slice(0, 10) === dates[0]);
    const mentionedNow = latestRuns.filter((r) => r.mentioned);
    const positions = mentionedNow.map((r) => r.approximate_position).filter((n) => n != null);
    const competitors = [...new Set(latestRuns.flatMap((r) => (Array.isArray(r.competitors_mentioned) ? r.competitors_mentioned : [])))];

    const row = {
      id: p.id,
      promptText: p.prompt_text,
      source: p.source,
      checks: dates.length,
      hits: hitDates.size,
      engines: [...new Set(latestRuns.map((r) => r.provider))],
      seenOn: [...new Set(mentionedNow.map((r) => r.provider))],
      position: positions.length ? Math.min(...positions) : null,
      competitors,
      ship: p.ship_draft_id ? 'drafted' : p.ship_requested_at ? 'queued' : null,
      shipError: p.ship_error || null,
      draftId: p.ship_draft_id || null,
    };
    (mentionedNow.length ? seen : missing).push(row);
  }
  seen.sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || b.hits - a.hits);
  missing.sort((a, b) => (a.ship ? 1 : 0) - (b.ship ? 1 : 0) || b.competitors.length - a.competitors.length);

  // One row per distinct phrase, with how many missing prompts it would cover.
  const phrases = new Map();
  for (const m of missing) {
    const phrase = keyPhrase(m.promptText);
    if (!phrase) continue;
    const cur = phrases.get(phrase) || { phrase, covers: 0 };
    cur.covers++;
    phrases.set(phrase, cur);
  }
  const words = [...phrases.values()]
    .sort((a, b) => b.covers - a.covers || a.phrase.localeCompare(b.phrase))
    .map((w) => ({ ...w, page: bestPageFor(w.phrase, pages) }));

  // Prompts worth tracking next: the same phrases phrased the way a buyer ranks options,
  // skipping anything already tracked. Derived, never invented from outside the data.
  const have = new Set(prompts.map((p) => p.prompt_text.toLowerCase().trim()));
  const suggestions = words.map((w) => `best ${w.phrase}`).filter((t) => !have.has(t)).slice(0, 4);

  return { seen, missing, words, suggestions };
}
