// Catches generated content that still contains its own scaffolding: an
// unfilled bracketed placeholder, a markdown link whose href was never
// resolved, or a comparison against a competitor the model made up.
//
// WHY THIS EXISTS
//
// All three shipped to zunkireelabs.com and sat live on customer-facing pages
// (repaired 2026-08-31):
//
//   /contact/    compared the company to "Competitor X" whose location cell
//                read "[Competitor Location]"
//   /careers/    compared it to "Competitor A", "B" and "C"
//   a location   page compared a "[Competitor Region]" on rows whose cells
//                were "[Generic solutions]" and "[Different focus]"
//   a resources  page rendered "refer to [Authoritative Source on AI in
//                Search](URL)" literally, brackets and all
//
// The existing scaffolding guard looks for editorial leftovers aimed at a
// human ("FAQ topics to cover", "Suggested internal links"). These are a
// different failure: the model produced the SHAPE of a well-researched claim
// and left the facts as blanks, so the output reads as finished work. Nothing
// downstream could tell — a placeholder is valid prose, valid HTML, and
// perfectly on-brand in tone.
//
// A fabricated competitor is the most serious of the three. A comparison table
// is a claim about a real alternative, published on a page a customer reads
// before deciding to make contact. One built from placeholders is not a weaker
// claim, it is an invented one, and it is exactly the kind of thing a reviewer
// skims past because it looks like every other comparison table.
//
// The right response is to fail the draft, not to patch it: there is no honest
// way to fill in a competitor's real location or a citation URL, and a
// plausible-looking substitute is worse than the blank, because nobody would
// know to check it.

// A markdown link whose href was never resolved — "(URL)", "()", "(#)". A real
// URL, a real path, or an anchor with a fragment all pass.
// Link text as short as one character still counts: the defect is the EMPTY
// or placeholder href, not the label. An earlier 3-character minimum let
// "[A](URL)" through, which is the same broken output with a shorter name.
const UNRESOLVED_LINK = /\[[^\]\n]{1,120}\]\((?:URL|url|TBD|tbd|#)?\)/;

// A bracketed slot the model was meant to replace. Deliberately narrow: it has
// to start with a capital and read like a label, so ordinary bracketed prose
// ("[sic]", "[2026]", a citation marker) does not trip it.
const BRACKET_PLACEHOLDER = /\[(?:Competitor|Company|Client|Customer|Generic|Specific|Different|Support|Speed|Insert|Add|Your|Name|Location|Region|Industry|Product|Service|Price|Number|Date|URL|Link|Source|Title)\b[^\]\n]{0,60}\]/;

// A competitor invented to fill a column. Real competitor names are real
// words; "Competitor X" and "Competitor A" are the model naming a variable.
const FABRICATED_COMPETITOR = /\bCompetitor\s+[A-Z]\b(?!\w)/;

const CHECKS = [
  [UNRESOLVED_LINK, 'unresolved-link', 'an unresolved markdown link (the href was never filled in, so the page would show the literal [text](URL) syntax)'],
  [BRACKET_PLACEHOLDER, 'unfilled-placeholder', 'an unfilled bracketed placeholder'],
  [FABRICATED_COMPETITOR, 'fabricated-competitor', 'a comparison against an invented competitor ("Competitor X"), which publishes a fabricated claim about a real market'],
];

// Walks every string in the content object WITH its path, including table
// cells — the original incident lived entirely inside expand-content's
// structured `table` rows, which no prose-level check would ever have looked
// at, and a reviewer needs to be told which cell to look in.
function collectStrings(value, path = '', out = []) {
  if (typeof value === 'string') out.push({ path: path || 'content', text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

/**
 * @returns {{issues: Array<{path, patternId, snippet, detail}>}} one issue per
 * distinct problem, in the { path, patternId, snippet } shape every sibling
 * guard returns so runQualityGate's callers can render them uniformly.
 */
export function checkPlaceholders(content) {
  const strings = collectStrings(content);
  const issues = [];
  for (const [pattern, patternId, description] of CHECKS) {
    const hit = strings.find((s) => pattern.test(s.text));
    if (!hit) continue;
    issues.push({
      path: hit.path,
      patternId,
      snippet: pattern.exec(hit.text)[0].slice(0, 120),
      detail: `Generated content contains ${description}. Regenerate with real values or drop the claim — do not fill it in with a plausible guess.`,
    });
  }
  return { issues };
}
