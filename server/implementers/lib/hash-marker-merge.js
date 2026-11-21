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

// ── placing a missing marker pair (nginx) ──────────────────────────────────────────────────────────────────────────────────────────────
// Earlier a missing pair was always a refusal, which left every nginx site that was not hand-prepared unable to receive these fixes. The
// pair can be placed deterministically and safely: right after the opening line of the server block that actually serves the site (the
// first `server {` whose body has `root` or `try_files`; a block that only redirects is skipped). Anything else is still a refusal. The
// change reaches the client only as a reviewed pull request, and the brace check still runs on the result.

// The same text with every real comment blanked to spaces (same length, so offsets still line up). nginx starts a comment only at the
// start of a token: `# note` is one, `/services/#top` is not.
function blankComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '#' && (i === 0 || /[\s;{}]/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      if (i < src.length) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

// Index just past the `}` that closes the block opened at `openIdx` (a `{`), on comment-blanked text. Quoted strings are skipped.
function matchingClose(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") { const q = ch; i++; while (i < src.length && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

export function findServingServerBlock(content) {
  const text = blankComments(content);
  const re = /(^|\n)([ \t]*)server\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('{', m.index + m[1].length);
    const end = matchingClose(text, open);
    if (end === -1) return null;
    const body = text.slice(open + 1, end - 1);
    if (/(^|\s)(root\s|try_files\s)/.test(body)) {
      const nl = content.indexOf('\n', open);
      return { open, end, indent: m[2], lineEnd: nl === -1 ? open + 1 : nl + 1 };
    }
    re.lastIndex = end;
  }
  return null;
}

// Locations inside the serving block that set their own add_header (nginx then drops every server-level add_header for them).
export function locationsDroppingServerHeaders(content) {
  const block = findServingServerBlock(content);
  if (!block) return [];
  const body = blankComments(content).slice(block.open + 1, block.end - 1);
  const out = [];
  const re = /(^|\n)[ \t]*location\s+([^{\n]+)\{/g;
  let m;
  while ((m = re.exec(body))) {
    const open = m.index + m[0].length - 1;
    const end = matchingClose(body, open);
    if (end === -1) break;
    if (/^\s*add_header\s/m.test(body.slice(open + 1, end - 1))) out.push(m[2].trim());
    re.lastIndex = end;
  }
  return out;
}

export function ensureHashMarker(fileContent, markerName) {
  if (hashBlockRegex(markerName).test(fileContent)) return { ok: true, content: fileContent, inserted: false };
  const block = findServingServerBlock(fileContent);
  if (!block) {
    return { ok: false, reason: 'no-insertion-marker', error: `Marker "SEOAI:${markerName}" is missing and no server { } block with a root or try_files was found to place it in.` };
  }
  const pad = `${block.indent}    `;
  const insert = `${pad}# SEOAI:${markerName}:START\n${pad}# SEOAI:${markerName}:END\n`;
  return { ok: true, content: fileContent.slice(0, block.lineEnd) + insert + fileContent.slice(block.lineEnd), inserted: true };
}
