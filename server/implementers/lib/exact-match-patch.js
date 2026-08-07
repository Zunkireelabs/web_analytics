// Generic "find this exact literal text in the file, replace it" patch
// primitive shared by every auto-fix that must touch a specific EXISTING
// element inside a site's own template source rather than filling in one
// designated marker slot (schema-repair.js's malformed/duplicate JSON-LD
// blocks, alt-text.js's <img> tags). A live page's rendered HTML (what
// page-content.js fetched) and a component-based site's real template
// SOURCE can differ — dynamic data, loops, build-time transforms — so an
// exact, unique substring match is the only way to know the anchor still
// really is what detection thought it was. Refuses rather than guesses
// whenever an anchor is missing or ambiguous, same "strict conditions, no
// ambiguous matches" rule implementers/lib/duplicate-id-inject.js already
// follows for its own narrow auto-fix shape.

export function countOccurrences(fileContent, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = fileContent.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = fileContent.indexOf(needle, idx + needle.length);
  }
  return count;
}

// Applies a batch of {anchor, replacement} edits to fileContent. Every
// anchor is checked against the ORIGINAL fileContent before any edit is
// applied — an earlier edit's replacement text can never accidentally
// create or destroy a match for a later edit still pending. All-or-nothing:
// if ANY anchor is missing or appears more than once, no edit is applied at
// all, and the caller gets back exactly which anchor(s) failed and why.
export function applyExactMatchPatches(fileContent, edits) {
  const missing = [];
  const ambiguous = [];
  for (const { anchor } of edits) {
    const count = countOccurrences(fileContent, anchor);
    if (count === 0) missing.push(anchor);
    else if (count > 1) ambiguous.push(anchor);
  }
  if (missing.length || ambiguous.length) return { ok: false, missing, ambiguous };

  let content = fileContent;
  for (const { anchor, replacement } of edits) content = content.replace(anchor, replacement);
  return { ok: true, content };
}

// One human-readable sentence for the {ok:false} case above — shared so
// schema-repair.js's and alt-text.js's implementers report the same shape
// of error rather than each wording it slightly differently.
export function describePatchFailure(filePath, { missing, ambiguous }) {
  const parts = [];
  if (missing.length) parts.push(`${missing.length} anchor(s) no longer found verbatim in ${filePath}`);
  if (ambiguous.length) parts.push(`${ambiguous.length} anchor(s) appear more than once in ${filePath} (ambiguous, can't tell which to patch)`);
  return `${parts.join('; ')} — the source may have changed since this draft was generated. Regenerate the draft, or edit ${filePath} manually.`;
}
