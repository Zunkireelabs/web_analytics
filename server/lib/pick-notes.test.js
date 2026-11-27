import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPickNotes, instructionWithNotes } from './pick-notes.js';

describe('the changes a person asks for on an idea', () => {
  test('no notes is fine; notes are cleaned and keep their order', () => {
    assert.deepEqual(cleanPickNotes(undefined), { ok: true, notes: [] });
    const r = cleanPickNotes([{ part: '  Why it matters ', text: '  make   this\nshorter ' }, { text: 'Use a friendlier tone' }]);
    assert.deepEqual(r.notes, [{ part: 'Why it matters', text: 'make this shorter' }, { part: null, text: 'Use a friendlier tone' }]);
  });
  test('an empty note, a too-long note, too many notes, or something that is not a list is refused', () => {
    assert.equal(cleanPickNotes([{ text: '   ' }]).ok, false);
    assert.equal(cleanPickNotes([{ text: 'x'.repeat(601) }]).ok, false);
    assert.equal(cleanPickNotes(Array.from({ length: 13 }, () => ({ text: 'a' }))).ok, false);
    assert.equal(cleanPickNotes('nope').ok, false);
  });
});

describe('the writer\'s instruction', () => {
  test('with no notes the instruction is exactly the structure they chose', () => {
    assert.equal(instructionWithNotes('CHOSE: Short answer first', []), 'CHOSE: Short answer first');
    assert.equal(instructionWithNotes('CHOSE: x', null), 'CHOSE: x');
  });
  test('with notes: the chosen structure, then each change by part, and the rule that facts are never added', () => {
    const out = instructionWithNotes('CHOSE: Short answer first', [{ part: 'Why it matters', text: 'make it shorter' }, { part: null, text: 'friendlier tone' }]);
    assert.ok(out.startsWith('CHOSE: Short answer first'));
    assert.match(out, /- Part \[Why it matters\]: make it shorter/);
    assert.match(out, /- Whole piece: friendlier tone/);
    assert.match(out, /never add a statistic, number, date, name or claim/);
  });
});

test('a change on one element carries its current words and where it sits, so the writer finds that element only', () => {
  const clean = cleanPickNotes([{ part: 'Button: “Send enquiry”', partText: 'Send enquiry', context: 'inside Form', text: 'make it more visible' }]);
  assert.equal(clean.ok, true);
  const out = instructionWithNotes('CHOSE: A', clean.notes);
  assert.match(out, /Part \[Button: “Send enquiry”\] currently reads "Send enquiry", inside Form: make it more visible/);
  assert.match(out, /THAT ONE element only/);
});

