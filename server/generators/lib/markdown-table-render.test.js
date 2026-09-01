import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findMarkdownTables, buildTableHtml, projectMarkdownTablesInBody } from './markdown-table-render.js';

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
