// Moved here from agents/query-intelligence.js (which re-exports it) so
// non-agent code — e.g. site-ctr-curve.js — can use it without importing an
// agent module and its LLM dependency.
//
// A branded query (the site's own name) legitimately shows many of the
// site's own pages clustered at position ~1 — real Google sitelinks
// behavior for a brand search, not cannibalization. Filtered out using the
// site's own real `name`, never a guessed brand list.
export function isBrandedQuery(query, siteName) {
  if (!siteName) return false;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedName = normalize(siteName);
  if (!normalizedName) return false;
  // Padded-space containment on the already-tokenized string, not a bare
  // substring check — a bare .includes() false-negatives real cannibalization
  // for a short/generic brand name (e.g. site "Go" would suppress every
  // legitimate "golang" query as if it were a branded self-match).
  if (` ${normalize(query)} `.includes(` ${normalizedName} `)) return true;
  // Also a brand query when every token of the query is a token of the site
  // name: a site called "Admizz Education" is searched as just "admizz", and
  // that search legitimately shows several of its own pages as sitelinks.
  // Subset (not overlap), so "education loan" does not count as branded just
  // because it shares one generic word with the name.
  const nameTokens = new Set(normalizedName.split(' '));
  const queryTokens = normalize(query).split(' ').filter(Boolean);
  return queryTokens.length > 0 && queryTokens.every((t) => nameTokens.has(t));
}
