import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findSelected, replaceSelected, rewriteSelectedWords } from './selected-words.js';
import { rewriteBlock } from './draft-live-preview.js';

describe('editing exactly the selected words', () => {
  const text = 'A missed appointment leaves a chair empty. A text the day before, and a short nudge on the day, gives clients an easy way to confirm.';
  test('only the selected words are replaced; everything else stays byte for byte', () => {
    assert.equal(replaceSelected(text, 'a short nudge on the day', 'a quick reminder'), 'A missed appointment leaves a chair empty. A text the day before, and a quick reminder, gives clients an easy way to confirm.');
  });
  test('whitespace differences between the page and the stored text do not matter', () => {
    assert.ok(findSelected('one  two\nthree', 'one two three'));
  });
  test('words that are not there, or that appear twice, are not guessed at', () => {
    assert.equal(findSelected(text, 'not in the text'), null);
    assert.equal(findSelected('go go', 'go'), null);
  });
  test('a section edit rewrites only the selection and leaves the heading and the rest of the body alone', async () => {
    const block = { kind: 'section', label: 'Section', value: { heading: 'Send reminders', body: 'First sentence stays. Remove this clutter now. Last sentence stays.' } };
    const seen = [];
    const out = await rewriteBlock({ block, instruction: 'shorter', selected: 'Remove this clutter now', callJson: async (_s, u) => { seen.push(u); return { text: 'Cut it' }; } });
    assert.deepEqual(out, { heading: 'Send reminders', body: 'First sentence stays. Cut it. Last sentence stays.' });
    assert.match(seen[0], /Selected words \(rewrite only these\):\nRemove this clutter now/);
  });
  test('selection that cannot be located falls back to rewriting the whole part', async () => {
    const block = { kind: 'quick', label: 'Short answer', value: 'The whole answer.' };
    const out = await rewriteBlock({ block, instruction: 'shorter', selected: 'words not present', callJson: async () => ({ text: 'Whole new answer.' }) });
    assert.equal(out, 'Whole new answer.');
  });
  test('an empty rewrite is refused', async () => {
    await assert.rejects(rewriteSelectedWords({ selected: 'x', instruction: 'y', callJson: async () => ({ text: '' }) }), /empty/);
  });
});
