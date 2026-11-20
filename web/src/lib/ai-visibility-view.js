// What the AI visibility page shows, worked out from the board the server already returns. Pure, so it is tested without a browser.

// The headline: AI recommends you in N of M checked questions.
export function summary(seen = [], missing = []) {
  const n = seen.length, total = seen.length + missing.length;
  return { n, total, pct: total ? Math.round((n / total) * 100) : 0 };
}

// One bar per AI engine: how many of the questions it was asked name you. An engine that is not connected has no numbers.
export function engineRows(engines = [], seen = [], missing = []) {
  return engines.map((e) => {
    const asked = [...seen, ...missing].filter((r) => (r.engines || []).includes(e.id));
    const named = seen.filter((r) => (r.seenOn || []).includes(e.id));
    return { id: e.id, configured: Boolean(e.configured), n: named.length, total: asked.length, pct: asked.length ? Math.round((named.length / asked.length) * 100) : 0 };
  });
}

// "Words to add", grouped by the page they would go on, biggest first. A phrase with no existing page goes under "New page".
export function groupWords(words = []) {
  const by = new Map();
  for (const w of words) {
    const key = w.page || '';
    const g = by.get(key) || { page: w.page || null, phrases: [], promptIds: new Set() };
    g.phrases.push(w.phrase);
    for (const id of w.promptIds || []) g.promptIds.add(id);
    by.set(key, g);
  }
  return [...by.values()].map((g) => ({ ...g, promptIds: [...g.promptIds], count: g.phrases.length }))
    .sort((a, b) => b.count - a.count || String(a.page).localeCompare(String(b.page)));
}

// The questions a "Draft these" press sends: unique, and no more than the server takes in one go.
export const MAX_SHIP = 25;
export function shipIds(ids = [], max = MAX_SHIP) {
  const u = [...new Set(ids.map(Number).filter(Number.isInteger))];
  return { ids: u.slice(0, max), left: Math.max(0, u.length - max) };
}

// How the headline moved since the last check, from the saved history of percentages (oldest first). null when there is no earlier point.
export function trend(history = []) {
  const v = history.map((h) => h?.pct).filter((x) => x != null);
  if (v.length < 2) return null;
  const d = v[v.length - 1] - v[v.length - 2];
  return d === 0 ? { dir: 'same', points: 0 } : { dir: d > 0 ? 'up' : 'down', points: Math.abs(Math.round(d)) };
}
