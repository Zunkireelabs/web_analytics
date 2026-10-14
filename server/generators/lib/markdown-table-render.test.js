import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findMarkdownTables, findFlattenedMarkdownTables, buildTableHtml, projectMarkdownTablesInBody } from './markdown-table-render.js';

describe('findMarkdownTables', () => {
  test('parses a real GFM table into header + body rows', () => {
    const body = 'Intro.\n\n| Brand | Price |\n| --- | --- |\n| A | £1 |\n| B | £2 |\n\nOutro.';
    const [table] = findMarkdownTables(body);
    assert.deepEqual(table.rows, [['Brand', 'Price'], ['A', '£1'], ['B', '£2']]);
  });

  test('finds more than one table in the same body', () => {
    const body = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntext\n\n| C | D |\n| --- | --- |\n| 3 | 4 |';
    const tables = findMarkdownTables(body);
    assert.equal(tables.length, 2);
  });

  test('a header-only table (no data rows) is still found', () => {
    const body = '| A | B |\n| --- | --- |\n';
    const [table] = findMarkdownTables(body);
    assert.deepEqual(table.rows, [['A', 'B']]);
  });

  test('ordinary prose with no table is untouched', () => {
    assert.deepEqual(findMarkdownTables('Just some plain prose. No pipes at all.'), []);
  });

  test('a stray pipe with no separator line is not mistaken for a table', () => {
    assert.deepEqual(findMarkdownTables('| this looks like it might be a table row\nbut the next line is not a separator'), []);
  });
});

// Regression coverage for a real production bug: a section body returned
// from the model as a single JSON string arrived with its table's row
// breaks collapsed to spaces, so the table shipped as raw pipe text with no
// visible structure — findMarkdownTables' line-based scan never matches it
// because there are no newlines to split rows on at all.
describe('findFlattenedMarkdownTables', () => {
  test('parses a table whose rows were joined onto one line by spaces', () => {
    const body = 'Here is a breakdown: | Feature | AI-Native Search | Traditional Keyword Search | '
      + '|---|---|---| | User Intent | Understands intent | Matches terms | | Response Type | Direct answers | Ranked links |';
    const [table] = findFlattenedMarkdownTables(body);
    assert.deepEqual(table.rows[0], ['Feature', 'AI-Native Search', 'Traditional Keyword Search']);
    assert.deepEqual(table.rows[1], ['User Intent', 'Understands intent', 'Matches terms']);
    assert.deepEqual(table.rows[2], ['Response Type', 'Direct answers', 'Ranked links']);
  });

  test('a genuine multi-line table (real newlines) is left for findMarkdownTables, not double-matched here', () => {
    const body = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    assert.deepEqual(findFlattenedMarkdownTables(body), []);
  });

  test('ordinary prose with a stray pipe or two is not mistaken for a flattened table', () => {
    assert.deepEqual(findFlattenedMarkdownTables('The ratio is 1 | 2 in most cases, nothing more.'), []);
  });

  test('projectMarkdownTablesInBody converts a flattened table too', () => {
    const body = 'Intro: | A | B | |---|---| | 1 | 2 |';
    const out = projectMarkdownTablesInBody(body, null);
    assert.match(out, /<table>/);
    assert.match(out, /<th>A<\/th>/);
    assert.doesNotMatch(out, /\|---\|---\|/);
  });
});

describe('buildTableHtml', () => {
  test('renders a real <table> with the given styles', () => {
    const html = buildTableHtml([['A', 'B'], ['1', '2']], { tableClass: 'tbl', headerCellClass: 'th', rowClass: 'tr', cellClass: 'td' });
    assert.match(html, /<table class="tbl">/);
    assert.match(html, /<th class="th">A<\/th>/);
    assert.match(html, /<td class="td">1<\/td>/);
  });

  test('null styles still produce a real, bare table', () => {
    const html = buildTableHtml([['A'], ['1']], null);
    assert.match(html, /<table><thead>/);
  });

  test('escapes HTML in cell content', () => {
    const html = buildTableHtml([['<script>']], null);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('projectMarkdownTablesInBody', () => {
  const PROFILE = { typography: { body: 'text-gray-600', heading: { item: 'text-lg' } }, color: { border: 'border-gray-200' } };

  test('replaces a real markdown table with the projected HTML table', () => {
    const body = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const out = projectMarkdownTablesInBody(body, PROFILE);
    assert.match(out, /<table class="w-full border-collapse">/);
    assert.doesNotMatch(out, /\| --- \| --- \|/);
  });

  test('null profile still yields a real (bare) table, not raw markdown', () => {
    const body = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const out = projectMarkdownTablesInBody(body, null);
    assert.match(out, /<table>/);
    assert.doesNotMatch(out, /\| --- \| --- \|/);
  });

  test('a body with no table passes through unchanged', () => {
    assert.equal(projectMarkdownTablesInBody('just prose', PROFILE), 'just prose');
  });

  test('empty body is a no-op', () => {
    assert.equal(projectMarkdownTablesInBody('', PROFILE), '');
  });
});
