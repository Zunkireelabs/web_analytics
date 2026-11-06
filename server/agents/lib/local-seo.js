import { resolveSiteLocations } from './site-locations.js';

// Local SEO for a client who works in named places (migration 241: sites.target_places).
//
// One module reads that list and everything location-shaped is built from it: which phrases get researched, which
// keywords count as location work, what an AI assistant is asked, which keywords are worth tracking, and what a content
// generator is told about the client's patch. Nothing else interprets places, so the order and the rules cannot drift.
//
// Three rules shape it:
//   1. ORDER IS PRIORITY. The primary place comes first everywhere, so a capped run spends its budget on the home town
//      before any neighbour.
//   2. NOTHING IS INFERRED. A place is used only if the client declared it. A generator is told not to claim an office,
//      branch or presence anywhere the client did not name — telling a business it "serves Leicester" because Leicester
//      is near Northampton is exactly the kind of confident invention that ends up on a live page.
//   3. NO PLACES MEANS NO CHANGE. A site with none behaves as it always did, falling back to its country.

const MAX_PLACES = 12;

/** The declared places, cleaned: primary first, then nearby in the order given. Never throws on bad data. */
export function targetPlaces(site) {
  const raw = Array.isArray(site?.target_places) ? site.target_places : [];
  const seen = new Set();
  const cleaned = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    const text = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (text.length < 2 || text.length > 60) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ name: text, tier: entry?.tier === 'primary' ? 'primary' : 'nearby' });
  }
  // Primary entries lead regardless of where they were written; within a tier the declared order is kept.
  return [...cleaned.filter((p) => p.tier === 'primary'), ...cleaned.filter((p) => p.tier !== 'primary')].slice(0, MAX_PLACES);
}

export const placeNames = (site, { max = MAX_PLACES } = {}) => targetPlaces(site).slice(0, max).map((p) => p.name);
export const hasPlaces = (site) => targetPlaces(site).length > 0;

/**
 * The research phrases for a local client: each service, then each service in each place — primary place for EVERY
 * service before any nearby place gets a turn, so when a cap trims the list it trims the neighbours, not the home town.
 */
export function placeSeedPhrases(services, places, { max = 60 } = {}) {
  const clean = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const svc = [...new Set((services || []).map(clean).filter((s) => s.length >= 3))];
  const ordered = (places || []).map((p) => (typeof p === 'string' ? { name: p, tier: 'nearby' } : p)).filter((p) => p?.name);
  const out = [...svc]; // the bare service first: "estate agents" still tells the provider what market this is
  for (const place of ordered) {
    const name = clean(place.name);
    for (const s of svc) out.push(`${s} ${name}`);
  }
  return [...new Set(out)].slice(0, max);
}

/** British conventions for UK clients. Derived from the site's own market, never assumed. */
export function isUkSite(site) {
  try { return resolveSiteLocations(site).some((l) => Number(l.locationCode) === 2826); } catch { return false; }
}

/**
 * What a content generator is told about a local client's patch. Null when there is nothing real to say, so a site with
 * no declared places and no UK market gets a prompt byte-for-byte as it was.
 */
export function localSeoNote(site) {
  const places = targetPlaces(site);
  const uk = isUkSite(site);
  if (!places.length && !uk) return null;

  const parts = [];
  if (places.length) {
    const primary = places.filter((p) => p.tier === 'primary').map((p) => p.name);
    const nearby = places.filter((p) => p.tier !== 'primary').map((p) => p.name);
    parts.push(
      `Local focus: write for customers in ${primary.length ? primary.join(' and ') : places[0].name} first`
      + (nearby.length ? `, and for people in nearby ${nearby.slice(0, 6).join(', ')}` : '')
      + '. Use these place names naturally where this page genuinely serves them.'
    );
    parts.push(
      'Only name a place from that list. Never say or imply the business has an office, branch, team or presence in any '
      + 'place not named here, and never invent local facts (landmarks, prices, statistics, named streets) that were not provided.'
    );
  }
  if (uk) {
    parts.push(
      'Write in British English: -ise spellings (organisation, specialise), "colour", "programme", "postcode", "mobile", '
      + 'prices in £, dates as day month year.'
    );
  }
  return parts.join(' ');
}

/** The market names prompts and questions use: places first (most specific), then the country. */
export function localMarketNames(site, countryNames = [], { maxPlaces = 4 } = {}) {
  const places = placeNames(site, { max: maxPlaces });
  return [...new Set([...places, ...countryNames])];
}

/**
 * Keywords worth watching for a local client: each verified service in the PRIMARY place only. Deliberately narrow — a
 * rank check costs money per keyword and the home town is where winning matters first; nearby towns are researched, and
 * can be tracked once the primary ones are placed.
 */
export function suggestLocalKeywords(site, services, { limit = 10 } = {}) {
  const primary = targetPlaces(site).find((p) => p.tier === 'primary') || targetPlaces(site)[0];
  if (!primary) return [];
  return placeSeedPhrases(services, [primary], { max: 200 })
    .filter((phrase) => phrase.endsWith(primary.name.toLowerCase())) // drop the bare services: only the local phrase
    .slice(0, limit);
}
