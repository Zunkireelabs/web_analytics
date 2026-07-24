// Marker-based splice for files that use `#`-style comments (nginx, and
// other config formats that don't understand HTML's `<!-- -->`) — the same
// literal-text-replacement philosophy as marker-merge.js's BLOCK convention,
// just anchored on a different comment syntax. Kept as its own small file
// rather than folded into marker-merge.js: the two mechanisms share almost
// nothing beyond "splice between two markers," and nginx's blast radius
// (a single shared server{} config, not a body-content region) also needs
// its own validation step (validateNginxBraces) that has no HTML analog.
//
//   # SEOAI:NAME:START
//   ...directives...
//   # SEOAI:NAME:END
//
// Deliberately NO auto-insert of a missing marker pair (contrast with
// marker-merge.js's insertBlockMarker, which safely appends at EOF for HTML
// body content). An nginx directive appended outside any `server {}` block
// is invalid or silently ineffective, so a missing marker here is an honest
// failure — a human places the marker pair once, inside the right server
// block, at onboarding.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashBlockRegex(markerName) {
  const start = `# SEOAI:${markerName}:START`;
  const end = `# SEOAI:${markerName}:END`;
  // [\s\S] (not .) so this matches across newlines. Captures the start/end
  // marker lines too, so a replacement can re-wrap them exactly, preserving
  // the marker for the next real merge.
  return new RegExp(`(${escapeRegExp(start)})([\\s\\S]*?)(${escapeRegExp(end)})`);
}

export function hasHashMarker(fileContent, markerName) {
  return hashBlockRegex(markerName).test(fileContent);
}

// Whatever's currently sitting inside a hash marker, verbatim — used to show
// an implemented draft's real, live content without recomputing anything
// (mirrors marker-merge.js's getMarkerContent).
export function getHashMarkerContent(fileContent, markerName) {
  const match = hashBlockRegex(markerName).exec(fileContent);
  return match ? match[2] : null;
}

// Replaces everything strictly between an existing `# SEOAI:<markerName>:START`
// / `:END` pair with `newBlock`, preserving the marker lines and surrounding
// indentation. Fails honestly if the marker pair isn't already present in
// the live file — never guesses where to insert it.
export function spliceHashBlock(fileContent, markerName, newBlock) {
  const regex = hashBlockRegex(markerName);
  if (!regex.test(fileContent)) {
    return {
      ok: false,
      reason: 'no-insertion-marker',
      error: `Marker "SEOAI:${markerName}" not found. Add "# SEOAI:${markerName}:START" and "# SEOAI:${markerName}:END" on their own lines inside the target server {} block before this can be applied.`,
    };
  }
  const before = fileContent.match(regex)[2];
  const newContent = fileContent.replace(regex, (_m, start, _old, end) => `${start}\n${newBlock}\n${end}`);

  // Defensive: confirm the splice didn't create/collapse a duplicate marker
  // (e.g. newBlock itself happening to contain marker-like text) — the
  // marker pair must still appear exactly once each after the write.
  const startCount = (newContent.match(new RegExp(escapeRegExp(`# SEOAI:${markerName}:START`), 'g')) || []).length;
  const endCount = (newContent.match(new RegExp(escapeRegExp(`# SEOAI:${markerName}:END`), 'g')) || []).length;
  if (startCount !== 1 || endCount !== 1) {
    return { ok: false, reason: 'merge-validation-failed', error: `Splicing "SEOAI:${markerName}" produced ${startCount} START marker(s) and ${endCount} END marker(s) — expected exactly one each. Refusing to write.` };
  }

  return { ok: true, newContent, changedRegion: { markerName, before, after: newBlock } };
}

// String-level guardrail — there's no way to run a real `nginx -t` here
// (pure REST writes, no clone, no nginx binary), so this is the best
// available check that a splice didn't corrupt the surrounding config:
// brace balance must hold, and the marker pair must still appear exactly
// once each post-splice (never duplicated, never swallowed).
export function validateNginxBraces(content) {
  const opens = (content.match(/{/g) || []).length;
  const closes = (content.match(/}/g) || []).length;
  if (opens !== closes) {
    return { ok: false, reason: 'unbalanced-braces', error: `Merged nginx config has ${opens} "{" but ${closes} "}" — refusing to write a possibly-corrupted config.` };
  }
  return { ok: true };
}
