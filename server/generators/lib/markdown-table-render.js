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

function escapeHtml(s) {
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

// Replaces every real markdown table in `body` with the tenant-projected
// HTML table `projectTable`'s own tokens produce — the same call
// content-integrity-repair.js's raw-text-table fix already makes for
// existing pages, now applied at generation time too. `profile` may be null
// (no design profile derived yet); buildTableHtml's own null-styles fallback
// already handles that safely.
export function projectMarkdownTablesInBody(body, profile) {
  if (!body) return body;
  const tables = findMarkdownTables(body);
  if (!tables.length) return body;
  const styles = projectTable(profile);
  let result = body;
  for (const table of tables) {
    result = result.replace(table.raw, buildTableHtml(table.rows, styles));
  }
  return result;
}
