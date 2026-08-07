// Safe, narrow-scope auto-fix for the duplicate-id-fix generator
// (server/generators/duplicate-id-fix.js). That generator stays advisory
// for the general case on purpose — a blind id rename can silently break a
// CSS selector, getElementById/querySelector call, or #anchor link that
// lives anywhere else in the repo, none of which a single page's captured
// snippet can rule out.
//
// This module only automates the one shape that's provably safe: an SVG
// <linearGradient>/<radialGradient>/<clipPath>/<mask> id that's ONLY ever
// referenced by a `url(#id)` fill/clip/mask inside its own <svg>...</svg>
// block — the common case when the same icon component is rendered twice on
// a page, each with its own (identically-named) gradient def. Renaming that
// id only ever affects paint inside its own element tree, so there's no
// cross-file or cross-component blast radius to reason about. Anything else
// (id referenced by CSS, JS, or an anchor link — in this file or any other
// in the repo) refuses rather than guesses, per the same "strict conditions,
// no ambiguous matches" lesson backend.js's other injectors already follow.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Any reference to #id that ISN'T a plain `url(#id)` paint reference means
// something outside this element's own render tree might depend on the id
// (a CSS rule, a getElementById/querySelector call, or a real navigational
// #anchor) — those are exactly the cases the generator's own comment warns
// about, so they refuse rather than guess.
export function hasDangerousReference(fileContent, id) {
  const escaped = escapeRegExp(id);
  const hashRef = new RegExp(`#${escaped}\\b`, 'g');
  const matches = [...fileContent.matchAll(hashRef)];
  const safeMatches = matches.filter((m) => fileContent.slice(Math.max(0, m.index - 4), m.index) === 'url(');
  if (safeMatches.length !== matches.length) return true;

  const jsRef = new RegExp(`(getElementById|querySelector(?:All)?)\\(["']#?${escaped}["']\\)`, 'g');
  return jsRef.test(fileContent);
}

// Repo-wide check, same searchCodeForString mechanism broken-link-fix's
// code-search fallback already uses — any OTHER file mentioning this id at
// all (as a literal string) is treated as a possible cross-file reference,
// since a full fetch-and-classify of every candidate isn't worth the extra
// API calls for what's meant to be the conservative, narrow-scope path.
export async function hasExternalReferences(site, id, ownFilePath, searchCodeForString) {
  const candidates = await searchCodeForString(site, id, { maxResults: 5 });
  return candidates.some((path) => path !== ownFilePath);
}

// Every <svg>...</svg> block in the file, in document order — non-greedy
// across nested tags, same technique as href-rewrite-inject.js's
// anchorRegex. Real markup essentially never nests <svg> inside <svg>.
function allSvgBlocks(fileContent) {
  return [...fileContent.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map((m) => ({
    start: m.index, end: m.index + m[0].length, block: m[0],
  }));
}

// Finds, in document order, the <svg> block enclosing EACH occurrence of
// `id="id"` (exact quoted value, so a longer id like "aiGradientMobile"
// never matches a lookup for "aiGradient"). Deliberately positional rather
// than snippet-text matching: when a page repeats the same icon component,
// every occurrence's captured snippet is byte-for-byte identical, so a
// substring search for "which occurrence is this" can't tell them apart —
// only their order in the file can. Callers align this array 1:1 against
// the generator's own occurrences array (also document order, per
// page-content.js's scan), and refuse rather than guess when the counts
// don't match.
export function findIdScopesInOrder(fileContent, id) {
  const escaped = escapeRegExp(id);
  const idAttr = new RegExp(`id=(["'])${escaped}\\1`, 'g');
  const svgBlocks = allSvgBlocks(fileContent);
  const scopes = [];
  for (const m of fileContent.matchAll(idAttr)) {
    const scope = svgBlocks.find((b) => b.start <= m.index && m.index < b.end);
    if (!scope) return null; // an id occurrence lives outside any <svg> — not the safe shape
    if (!scopes.some((s) => s.start === scope.start)) scopes.push(scope);
  }
  return scopes;
}

// Renames `id="oldId"` and every `url(#oldId)` paint reference inside a
// single already-located scope block, returning the rewritten block (not
// yet spliced back into the full file — callers batch multiple renames
// together via applyScopeRenames, since renaming several occurrences of
// possibly-different ids in one file needs one coherent set of edits, not
// N independent full-file rewrites that would invalidate each other's
// offsets).
function renameInBlock(block, oldId, newId) {
  const escaped = escapeRegExp(oldId);
  const idAttr = new RegExp(`id=(["'])${escaped}\\1`, 'g');
  const urlRef = new RegExp(`url\\((["']?)#${escaped}\\1\\)`, 'g');
  return block
    .replace(idAttr, (_m, quote) => `id=${quote}${newId}${quote}`)
    .replace(urlRef, (_m, quote) => `url(${quote}#${newId}${quote})`);
}

// Applies a batch of {start, end, oldId, newId} edits (each naming one
// already-located <svg> scope) to fileContent in one pass. Two different
// duplicate ids can share the same enclosing <svg> block (e.g. an icon with
// two gradient defs, both repeated) — those are grouped so every rename for
// that block lands in the one final write, rather than each independently
// overwriting the other from the same original text. Groups are then
// applied last-to-first so each group's start/end offsets — all computed
// against the ORIGINAL fileContent — stay valid throughout, regardless of
// how much earlier/later groups change the string length.
export function applyScopeRenames(fileContent, edits) {
  const groups = new Map();
  for (const edit of edits) {
    const key = `${edit.start}-${edit.end}`;
    if (!groups.has(key)) groups.set(key, { start: edit.start, end: edit.end, renames: [] });
    groups.get(key).renames.push({ oldId: edit.oldId, newId: edit.newId });
  }

  const sorted = [...groups.values()].sort((a, b) => b.start - a.start);
  let content = fileContent;
  for (const group of sorted) {
    let block = fileContent.slice(group.start, group.end);
    for (const { oldId, newId } of group.renames) block = renameInBlock(block, oldId, newId);
    content = content.slice(0, group.start) + block + content.slice(group.end);
  }
  return content;
}
