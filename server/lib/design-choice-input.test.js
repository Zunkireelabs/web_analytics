import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designChoiceInputFor, layoutNeedsPersonReason } from './design-choice-input.js';

const FAQ = { wrapper: '<dl>{{ROWS}}</dl>', row: '<dt>{{QUESTION}}</dt><dd>{{ANSWER}}</dd>' };
const QA = { wrapper: '<div>{{ROWS}}</div>', row: '<details><summary>{{QUESTION}}</summary>{{ANSWER}}</details>' };
const draft = (over = {}) => ({ id: 9, finding_id: 'f-faq-services', action_type: 'faq', input: { page: 'https://demo.example/services' }, content: { items: [] }, ...over });
const attempts = [{ what: 'Built the block in your usual style', result: 'Footer moved down 24px on phones' }, { what: 'Rewrote it with the measured problem as feedback', result: 'Text overflowed on tablet' }];

test('a stubborn FAQ on a site with two of its own FAQ layouts becomes a choice, with what was tried', () => {
  const r = designChoiceInputFor({ draft: draft(), componentTemplates: { faq: FAQ, qaContent: QA }, attempts });
  assert.equal(r.findingId, 'f-faq-services');
  assert.equal(r.generatorId, 'faq');
  assert.equal(r.title, 'Add an FAQ block to /services');
  assert.deepEqual(r.options.map((o) => o.key), ['faq', 'qaContent'], 'the options are the site\'s own templates');
  assert.match(r.reason, /tried 2 times/);
  assert.deepEqual(r.attempts, attempts);
});

test('no choice is offered when there is nothing real to choose between', () => {
  const t = { faq: FAQ, qaContent: QA };
  assert.equal(designChoiceInputFor({ draft: draft(), componentTemplates: { faq: FAQ }, attempts }), null, 'one layout');
  assert.equal(designChoiceInputFor({ draft: draft(), componentTemplates: {}, attempts }), null, 'no FAQ template at all (Admizz)');
  assert.equal(designChoiceInputFor({ draft: draft({ action_type: 'internal-links' }), componentTemplates: t, attempts }), null, 'not an FAQ');
  assert.equal(designChoiceInputFor({ draft: draft({ finding_id: null }), componentTemplates: t, attempts }), null, 'nothing to key the choice on');
});

test('a layout a person already picked that still breaks does not loop back to the same question', () => {
  const picked = draft({ content: { items: [], designTemplate: 'qaContent' } });
  assert.equal(designChoiceInputFor({ draft: picked, componentTemplates: { faq: FAQ, qaContent: QA }, attempts }), null);
});

test('a layout problem with no second layout is handed to a person with a plain reason that says what was tried', () => {
  const reason = layoutNeedsPersonReason({ draft: draft(), attempts });
  assert.match(reason, /^Needs a person:/);
  assert.match(reason, /tried 2 times to fit this into \/services/);
  assert.match(reason, /no other layout/i);
  assert.match(layoutNeedsPersonReason({ draft: { input: {} }, attempts: [] }), /several times/);
  // It must not read as one of the "wait, it fixes itself" kinds, which would hide it from the person.
  const kind = (r) => (/queued|currently running|hasn't been derived|has never been verified/i.test(r) ? 'awaiting' : /will retry automatically|shared (template|layout|css class|stylesheet)/i.test(r) ? 'other' : 'needs-person');
  assert.equal(kind(reason), 'needs-person');
});
