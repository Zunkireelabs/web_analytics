// The structural backstop the capability-repair job was missing: it used to
// validate only that the edited files still build (validateCapabilityRepair
// in capability-repair-task.js), never whether the model's write_file call
// preserved the RELATIVE ORDER of the page's existing sections. That gap is
// exactly how zunkireelabs-web's location-service.njk ended up with a new
// Services/FAQ/Nearby-Locations block spliced in ABOVE the page's existing
// Hero section — the build still passed, because the file was still valid
// Nunjucks, it was just visually wrong. This module gives that check a real,
// independent signal to run against: the site's own section-naming
// convention, read straight from the template being edited, not invented
// here.
//
// Deliberately best-effort, not a hard requirement that every template
// expose landmarks: a template with zero detectable landmarks in its BEFORE
// content yields `{ ok: true }` — there is nothing to compare order against,
// and refusing every repair on a template this convention doesn't recognize
// would make the job strictly less useful than the mis-placement bug it
// exists to prevent. It only ever blocks when it has real evidence of a
// reordering, never on the mere absence of evidence.

// Matches this codebase's own observed convention (see the live
// location-service.njk bug this closes) — a Nunjucks banner comment naming
// a section:
//   {# =====================================================
//      HERO SECTION
//      ===================================================== #}
// as well as the framework-agnostic HTML5 landmark tags and the common
// Tailwind-style "hero"/"header"/"footer"/"nav" class-name convention, so a
// template using plain semantic HTML (no banner comments) still gets real
// coverage.
const BANNER_COMMENT_RE = /\{#\s*=+\s*\r?\n\s*(.+?)\s*\r?\n\s*=+\s*#\}/g;
const SEMANTIC_TAG_RE = /<(header|nav|main|footer)[\s>]/gi;
const CLASS_LANDMARK_RE = /class="[^"]*\b(hero|header|footer|navbar|nav)\b[^"]*"/gi;

// Returns [{ label, index }] in FIRST-OCCURRENCE order — `index` is the
// character offset into `text`, used only to order landmarks against each
// other, never compared across old/new text directly (line numbers shift
// with any edit; only relative order matters).
function extractLandmarks(text) {
  const found = [];
  for (const re of [BANNER_COMMENT_RE, SEMANTIC_TAG_RE, CLASS_LANDMARK_RE]) {
    re.lastIndex = 0;
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(text))) {
      const label = (m[1] || m[0]).trim().toLowerCase();
      found.push({ label, index: m.index });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

// A small, dependency-free LCS line differ — same algorithm sandbox.js's
// own unifiedDiff uses internally, reimplemented here (not imported) since
// sandbox.js only exposes the string-formatted result, never the raw
// add/del/ctx ops this check needs to find where NEW lines landed.
const DIFF_LINE_LIMIT = 4000;

function diffLines(oldText, newText) {
  const oldLines = (oldText ?? '').split('\n');
  const newLines = (newText ?? '').split('\n');
  if (oldLines.length > DIFF_LINE_LIMIT || newLines.length > DIFF_LINE_LIMIT) return null; // too large — skip, don't guess
  const n = oldLines.length; const m = newLines.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { ops.push({ type: 'ctx', line: oldLines[i] }); i++; j++; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: 'del', line: oldLines[i] }); i++; } else { ops.push({ type: 'add', line: newLines[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', line: oldLines[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', line: newLines[j] }); j++; }
  return ops;
}

/**
 * Checks that editing `oldText` into `newText` preserved the relative order
 * of every landmark section detected in `oldText`, AND that no newly added
 * content was inserted before the first such landmark. Returns
 * `{ ok: true }` when either there's nothing to check (no landmarks found,
 * or the file is too large for the line differ) or the order genuinely held;
 * `{ ok: false, reason }` with a human-readable explanation otherwise.
 */
export function checkLandmarkOrderPreserved(oldText, newText) {
  const before = extractLandmarks(oldText);
  if (!before.length) return { ok: true, reason: 'no landmarks detected in the original file — nothing to check' };

  const afterLabels = extractLandmarks(newText).map((l) => l.label);
  // Relative-order check: the BEFORE label sequence must appear as a
  // subsequence of the AFTER label sequence (later matches allowed to
  // change position by co-occurring with genuinely new interleaved
  // sections, but never go backward relative to each other).
  let cursor = 0;
  for (const { label } of before) {
    const foundAt = afterLabels.indexOf(label, cursor);
    if (foundAt === -1) {
      return { ok: false, reason: `The existing "${label}" section is no longer present (or was reordered before an earlier section) after the edit — this repair only adds a new capability, it never removes or reorders existing sections.` };
    }
    cursor = foundAt + 1;
  }

  // No-new-content-before-first-landmark check: find where the FIRST
  // pre-existing landmark line now sits in the diff ops stream, and confirm
  // no 'add' op appears earlier in that stream than it does.
  const ops = diffLines(oldText, newText);
  if (!ops) return { ok: true, reason: 'file too large for the line differ — skipped' };

  const firstLabel = before[0].label;
  let firstLandmarkOpIndex = -1;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === 'del') continue; // a deleted line was never "reached" in the new file
    const line = op.line.toLowerCase();
    if (line.includes(firstLabel) || new RegExp(`\\b${firstLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) {
      firstLandmarkOpIndex = k;
      break;
    }
  }
  if (firstLandmarkOpIndex === -1) {
    // Already reported above as a stronger failure (label missing from
    // afterLabels) unless the banner comment's text itself was reformatted
    // — treat as inconclusive rather than a false accusation.
    return { ok: true, reason: `could not relocate the "${firstLabel}" landmark in the diff stream to check insertion position — treated as inconclusive` };
  }
  const addBeforeFirstLandmark = ops.slice(0, firstLandmarkOpIndex).some((op) => op.type === 'add');
  if (addBeforeFirstLandmark) {
    return { ok: false, reason: `New content was inserted BEFORE the existing "${firstLabel}" section instead of after the template's existing sections — this would render the new content above content like a Hero/Header that must stay first on the page.` };
  }

  return { ok: true };
}

// Exposed for buildCapabilityRepairPrompt — the ordered list of landmark
// labels found in the template's CURRENT content, so the prompt can name
// them explicitly instead of just hoping the model infers section order by
// reading raw markup.
export function detectLandmarkLabels(text) {
  const seen = new Set();
  const labels = [];
  for (const { label } of extractLandmarks(text)) {
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}
