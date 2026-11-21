import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withDesignCorrections } from './design-corrections.js';

test('appends the correction last, so it is the most recent instruction', () => {
  assert.equal(withDesignCorrections('Base prompt', { designCorrections: 'FIX THIS' }), 'Base prompt\n\nFIX THIS');
});

test('no correction -> the prompt is returned byte-for-byte unchanged', () => {
  for (const params of [undefined, null, {}, { designCorrections: '' }, { designCorrections: '   ' }, { designCorrections: 5 }]) {
    assert.equal(withDesignCorrections('Base prompt', params), 'Base prompt');
  }
});

// The failure this guards against: a generator that never reads the channel
// turns every "repair" into a regeneration of identical content. Every
// LLM-writing generator in the repair loop must route its prompt through the
// helper (or, for landing-page / blog-outline / translation, read the param).
test('every LLM-writing generator in the repair loop actually reads designCorrections', () => {
  const dir = path.resolve(import.meta.dirname, '..');
  for (const g of ['direct-answer', 'faq', 'qa-content', 'refresh-content', 'missing-page-create', 'expand-content', 'landing-page', 'blog-outline', 'translation']) {
    const src = fs.readFileSync(path.join(dir, `${g}.js`), 'utf8');
    assert.ok(/designCorrections|withDesignCorrections/.test(src), `${g}.js never reads the design-repair feedback channel`);
  }
});
