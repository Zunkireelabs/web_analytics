import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryForPattern, rootCauseForPattern } from './pattern-categories.js';

test('known patterns map to a real category and root cause', () => {
  assert.equal(categoryForPattern('todo-marker'), 'scaffolding');
  assert.ok(rootCauseForPattern('todo-marker'));
  assert.equal(categoryForPattern('nav-leakage'), 'nav-leakage');
  assert.equal(categoryForPattern('duplicate-paragraph'), 'duplicate-content');
  assert.equal(categoryForPattern('schema-missing-required-field'), 'schema-validity');
});

test('unknown pattern falls back to a generic category, not a crash', () => {
  assert.equal(categoryForPattern('some-future-pattern'), 'content-correction');
  assert.equal(rootCauseForPattern('some-future-pattern'), null);
});
