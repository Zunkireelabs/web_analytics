import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRows, DEFAULT_ROW_LIMIT } from './list-rows.js';

// Plain-JS check of the row-cap rule (the component itself is checked in the browser).
test('a long list is cut to the limit until expanded', () => {
  const rows = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(visibleRows(rows, DEFAULT_ROW_LIMIT, false).length, DEFAULT_ROW_LIMIT);
  assert.equal(visibleRows(rows, DEFAULT_ROW_LIMIT, true).length, 30);
});
test('a short list shows everything and needs no toggle', () => {
  assert.equal(visibleRows([1, 2, 3], 6, false).length, 3);
});
