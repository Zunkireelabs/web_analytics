import { projectTable } from '../../design-agent/lib/design-profile.js';

// Shared table-rendering primitive: turns rows of plain strings into a real
// <table>, styled with a tenant's own projected classes (design-profile.js's
// projectTable) when available, bare-but-real markup otherwise. Extracted out
// of content-integrity-repair.js (its original, still its only in-repo
// consumer of buildTableHtml until this file existed) so a markdown table
// inside NEWLY GENERATED content (blog-outline, landing-page, ...) can go
// through the exact same call instead of shipping as raw, unstyled
// `| --- |` markdown — one table pipeline for both repair and generation,
// not two that can drift apart. See newpage-render.js's
// projectMarkdownTablesInBody, the generation-side caller.

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(cls) {
  return cls ? ` class="${escapeHtml(cls)}"` : '';
}

// `styles` is design-profile.js's projectTable() output — this site's own
// real table pattern when one exists, or one composed from its own real
// typography/color tokens when it doesn't (see projectTable's own comment).
// null (no site, or no profile at all) falls back to bare unstyled markup —
// a real <table> is still a strictly better outcome than raw markdown/pipe
// text, even with no styling to apply. A horizontal-scroll wrapper is always
// added regardless of styles found — the one structural rule that holds for
// every tenant, not a style choice.
export function buildTableHtml(rows, styles = null) {
  const [header, ...body] = rows;
  const headHtml = `<tr>${header.map((c) => `<th${attr(styles?.headerCellClass)}>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const bodyHtml = body.map((r) => `<tr${attr(styles?.rowClass)}>${r.map((c) => `<td${attr(styles?.cellClass)}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="overflow-x-auto"><table${attr(styles?.tableClass)}><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// A GFM table separator row: `| --- | :---: | ---: |` (or without leading/
// trailing pipes). Requires at least one dash-run cell so a stray "| - |"
// line of prose doesn't false-positive.
const SEPARATOR_LINE_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

// Finds every real GFM markdown table in `body` (a header line starting with
// `|`, immediately followed by a separator line, followed by zero or more
// pipe-delimited data lines) and returns each as
// `{ rows: string[][], raw: string }`, `raw` being the exact original text
// span to replace. Deliberately line-based and conservative — a fenced code
// block containing `| a | b |` text is a real risk this does not special-case
// (same scope as this codebase's existing raw-text-table detector, which
// operates on already-extracted plain text, not full markdown-with-code-
// fences awareness) — acceptable here because the only callers are LLM-
// generated prose bodies, which do not fence a table meant to render as one.
export function findMarkdownTables(body) {
  if (!body) return [];
  const lines = body.split('\n');
  const tables = [];
  let i = 0;
  while (i < lines.length - 1) {
    const headerLine = lines[i];
    const sepLine = lines[i + 1];
    if (/^\s*\|/.test(headerLine) && SEPARATOR_LINE_RE.test(sepLine)) {
      const startLine = i;
      const rows = [splitRow(headerLine)];
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        rows.push(splitRow(lines[j]));
        j += 1;
      }
      tables.push({ rows, raw: lines.slice(startLine, j).join('\n') });
      i = j;
    } else {
      i += 1;
    }
  }
  return tables;
}

// Same GFM table shape as findMarkdownTables above, but for a table the
// model flattened onto ONE line — its rows joined by spaces instead of real
// newlines. Seen in practice: a section `body` returned as a single JSON
// string value routinely arrives with its embedded line breaks collapsed to
// spaces, so a table the model wrote with real rows in its own draft still
// reaches here as one run like
// `| Feature | X | Y | |---|---|---| | Row1 | ... |` — no `\n` anywhere for
// findMarkdownTables' line-based scan to split on, so it ships as raw pipe
// text with no visible structure at all.
//
// The only place two pipe characters appear with nothing but whitespace
// between them, in a well-formed pipe table, is exactly at a row boundary —
// the previous row's own closing pipe immediately followed by the next
// row's own opening pipe (an ordinary interior cell separator always has
// real cell content on at least one side). Walking those boundaries
// directly in the ORIGINAL text — never a reflowed/normalized copy — means
// the exact substring to replace is always a real, untouched slice of
// `body`, so a later `body.replace(table.raw, ...)` can never silently
// no-op because a normalized copy no longer matches the source
// byte-for-byte.
const ROW_BOUNDARY_RE = /\|[ \t]+\|/g;
// A real cell's worth of text between two boundaries; a much larger gap (or
// one crossing a paragraph break) means the two matches are unrelated pipe
// characters elsewhere in the body, not consecutive rows of one table.
const MAX_ROW_GAP = 400;

function buildFlattenedTableFromBoundaries(body, boundaries) {
  const first = boundaries[0];
  const last = boundaries[boundaries.length - 1];
  const prefix = body.slice(0, first.index);
  const suffixStart = last.index + last[0].length;
  const suffix = body.slice(suffixStart);

  // Row 0's OWN opening pipe is the first pipe in `prefix` — anything
  // before it (e.g. "Here is a breakdown: ") is lead-in prose, left alone.
  const leadPipe = prefix.indexOf('|');
  // The last row's OWN closing pipe is the last pipe in `suffix` —
  // anything after it is trailing prose, also left alone.
  const trailPipe = suffix.lastIndexOf('|');
  if (leadPipe === -1 || trailPipe === -1) return null;

  const rowTexts = [prefix.slice(leadPipe) + first[0][0]];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const mid = body.slice(boundaries[i].index + boundaries[i][0].length, boundaries[i + 1].index);
    rowTexts.push(boundaries[i][0].slice(-1) + mid + boundaries[i + 1][0][0]);
  }
  rowTexts.push(last[0].slice(-1) + suffix.slice(0, trailPipe + 1));

  if (!rowTexts.some((t) => SEPARATOR_LINE_RE.test(t.trim()))) return null; // no real separator row — not a table
  const dataRows = rowTexts.filter((t) => !SEPARATOR_LINE_RE.test(t.trim())).map(splitRow);
  if (dataRows.length < 2 || !dataRows.every((r) => r.length === dataRows[0].length && r.length >= 2)) return null;

  return { rows: dataRows, raw: body.slice(leadPipe, suffixStart + trailPipe + 1) };
}

export function findFlattenedMarkdownTables(body) {
  if (!body) return [];
  const boundaries = [...body.matchAll(ROW_BOUNDARY_RE)];
  const tables = [];
  let k = 0;
  while (k < boundaries.length) {
    let end = k;
    while (
      end + 1 < boundaries.length
      && boundaries[end + 1].index - (boundaries[end].index + boundaries[end][0].length) <= MAX_ROW_GAP
      && !body.slice(boundaries[end].index + boundaries[end][0].length, boundaries[end + 1].index).includes('\n\n')
    ) {
      end += 1;
    }
    const table = buildFlattenedTableFromBoundaries(body, boundaries.slice(k, end + 1));
    if (table) tables.push(table);
    k = end + 1;
  }
  return tables;
}

// Replaces every real markdown table in `body` with the tenant-projected
// HTML table `projectTable`'s own tokens produce — the same call
// content-integrity-repair.js's raw-text-table fix already makes for
// existing pages, now applied at generation time too. `profile` may be null
// (no design profile derived yet); buildTableHtml's own null-styles fallback
// already handles that safely. Real multi-line GFM tables are converted
// first; findFlattenedMarkdownTables then catches whatever survived that
// pass as a same-line-joined table (see its own comment above).
export function projectMarkdownTablesInBody(body, profile) {
  if (!body) return body;
  const styles = projectTable(profile);
  let result = body;

  for (const table of findMarkdownTables(result)) {
    result = result.replace(table.raw, buildTableHtml(table.rows, styles));
  }
  for (const table of findFlattenedMarkdownTables(result)) {
    result = result.replace(table.raw, buildTableHtml(table.rows, styles));
  }
  return result;
}
