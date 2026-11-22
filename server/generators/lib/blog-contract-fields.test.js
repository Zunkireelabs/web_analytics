import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { acceptQuickAnswer, acceptFaqItems, figuresIn } from './blog-contract-fields.js';

const sections = [
  { heading: 'Costs', body: 'The student visa fee is £558 and the health surcharge is £776 a year. About 30% of applicants ask for help.' },
  { heading: 'Timeline', body: 'Decisions usually arrive within 3 weeks of the biometrics appointment.' },
];
const qa = (q, a) => ({ question: q, answer: a });
const good = [
  qa('How much is the visa fee?', 'The student visa fee is £558, plus a health surcharge of £776 a year, as described above.'),
  qa('How long does a decision take?', 'Decisions usually arrive within 3 weeks of the biometrics appointment.'),
  qa('Do many applicants ask for help?', 'About 30% of applicants ask for help according to the post above.'),
];

describe('blog contract fields: only grounded text is accepted', () => {
  test('figures are compared by value, ignoring commas and spacing', () => {
    assert.deepEqual(figuresIn('£1,203 and 30 % and 3 weeks'), ['£1203', '30%', '3']);
  });
  test('quickAnswer: kept when its figures are in the post, dropped when a figure is invented, too short/long, or linky', () => {
    assert.ok(acceptQuickAnswer('The visa fee is £558 and a decision usually takes about 3 weeks after biometrics.', sections));
    assert.equal(acceptQuickAnswer('The visa fee is £999 and a decision usually takes about 3 weeks after biometrics.', sections), null);
    assert.equal(acceptQuickAnswer('Too short.', sections), null);
    assert.equal(acceptQuickAnswer('x'.repeat(400), sections), null);
    assert.equal(acceptQuickAnswer('See https://example.com for the visa fee of £558 and the 3 weeks timeline.', sections), null);
    assert.equal(acceptQuickAnswer(undefined, sections), null);
  });
  test('faqItems: three grounded items pass', () => {
    assert.equal(acceptFaqItems(good, sections).length, 3);
  });
  test('an item with an invented figure, a non-question, a link, or a duplicate is dropped', () => {
    const bad = [...good, qa('What is the fee?', 'The fee is £999 for everyone, which the post never states.'), qa('Not a question', 'The student visa fee is £558 as described.'),
      qa('Where do I apply?', 'Apply at https://example.com/visa for the £558 fee.'), qa('how much is the visa fee?', 'The student visa fee is £558, plus a health surcharge of £776 a year, again.')];
    assert.deepEqual(acceptFaqItems(bad, sections).map((x) => x.question), good.map((x) => x.question));
  });
  test('fewer than three usable items yields none (not a usable FAQ block); non-arrays yield none', () => {
    assert.deepEqual(acceptFaqItems(good.slice(0, 2), sections), []);
    assert.deepEqual(acceptFaqItems('nope', sections), []);
    assert.deepEqual(acceptFaqItems(null, sections), []);
  });
  test('at most five items are kept', () => {
    const many = Array.from({ length: 8 }, (_, i) => qa(`Question number ${i} about the visa?`, 'The student visa fee is £558, plus a health surcharge of £776 a year.'));
    assert.equal(acceptFaqItems(many, sections).length, 5);
  });
});
