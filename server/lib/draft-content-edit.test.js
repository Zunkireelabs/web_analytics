import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { editableFields, applyContentEdits, editDraftContent, rewriteDraftField } from './draft-content-edit.js';

const OG = { image: '/images/social-card.png', title: 'Zennly: salon and spa software', description: 'Bookings, staff and payments in one place.' };
const BLOG = { title: 'T', quickAnswer: 'Short.', page: 'https://s.example/blog/x/', groundingContext: 'We helped 2,000 students.', sections: [{ heading: 'One', body: 'Text one.' }], faqItems: [{ question: 'Q?', answer: 'A.' }], sources: [{ label: 'GOV.UK', url: 'https://www.gov.uk/x' }], featuredImage: { url: '/a.png', alt: 'Alt' } };
const draft = (content, status = 'submitted_for_approval') => ({ id: 1, status, action_type: 'x', content });
const gateOk = async () => ({ clean: true, issues: [] });
const saver = () => { const saved = []; return { saved, save: async (c) => { saved.push(c); return { id: 1, content: c }; } }; };

describe('which text of a draft can be edited', () => {
  test('an Open Graph draft: the title and description, not the image path', () => {
    assert.deepEqual(editableFields(OG).map((f) => f.path), ['title', 'description']);
  });
  test('a blog draft: the wording (title, short answer, sections, FAQ, image alt), never the address, the grounding text, the sources or the image path', () => {
    const paths = editableFields(BLOG).map((f) => f.path);
    assert.deepEqual(paths, ['title', 'quickAnswer', 'sections.0.heading', 'sections.0.body', 'faqItems.0.question', 'faqItems.0.answer', 'featuredImage.alt']);
    assert.ok(!paths.some((p) => /page|grounding|sources|url/i.test(p)));
  });
  test('labels read as plain words', () => {
    assert.equal(editableFields(BLOG).find((f) => f.path === 'faqItems.0.answer').label, 'FAQ 1 › Answer');
    assert.equal(editableFields(BLOG).find((f) => f.path === 'sections.0.body').label, 'Section 1 › Text');
    assert.equal(editableFields(BLOG).find((f) => f.path === 'quickAnswer').label, 'Short answer');
  });
});

describe('applying edits', () => {
  test('only the named fields change, and the original is untouched', () => {
    const r = applyContentEdits(OG, { description: 'A new description.' });
    assert.equal(r.content.description, 'A new description.');
    assert.equal(r.content.title, OG.title);
    assert.equal(OG.description, 'Bookings, staff and payments in one place.');
    assert.deepEqual(r.changed.map((c) => c.path), ['description']);
  });
  test('a field that is not editable, or an unknown path, is refused; so is emptying a field', () => {
    assert.throws(() => applyContentEdits(OG, { image: '/other.png' }), /cannot be edited/);
    assert.throws(() => applyContentEdits(BLOG, { 'page': 'https://evil.example' }), /cannot be edited/);
    assert.throws(() => applyContentEdits(BLOG, { 'sections.5.body': 'x' }), /cannot be edited/);
    assert.throws(() => applyContentEdits(OG, { title: '   ' }), /cannot be empty/);
  });
  test('saving the same text again is not a change', () => {
    assert.equal(applyContentEdits(OG, { title: OG.title }).changed.length, 0);
  });
});

describe('saving an edit', () => {
  test('a passing edit is saved in place and the new fields come back', async () => {
    const s = saver();
    const r = await editDraftContent({}, draft(OG), { description: 'Everything a salon needs, in one place.' }, { runGate: gateOk, save: s.save });
    assert.equal(r.ok, true);
    assert.equal(s.saved[0].description, 'Everything a salon needs, in one place.');
    assert.deepEqual(r.changed, ['description']);
  });
  test('only a problem the edit introduces blocks it', async () => {
    const old = { patternId: 'meta-description-length', detail: 'too short' };
    const s = saver();
    assert.equal((await editDraftContent({}, draft(OG), { title: 'A new title' }, { runGate: async () => ({ issues: [old] }), save: s.save })).ok, true);
    let n = 0;
    const gate = async () => (++n === 1 ? { issues: [old] } : { issues: [old, { patternId: 'competitor-link', detail: 'rival' }] });
    const bad = await editDraftContent({}, draft(OG), { title: 'See rival.com' }, { runGate: gate, save: s.save });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.issues.map((i) => i.rule), ['competitor-link']);
  });
  test('a number nothing supports is refused in any field; a supported one is fine', async () => {
    const s = saver();
    const bad = await editDraftContent({}, draft(BLOG), { 'faqItems.0.answer': 'Yes, 87% of customers see results in 5 days.' }, { runGate: gateOk, save: s.save });
    assert.equal(bad.ok, false);
    assert.equal(bad.issues[0].rule, 'ungrounded-claim');
    const fine = await editDraftContent({}, draft(BLOG), { quickAnswer: 'We have helped 2,000 students.' }, { runGate: gateOk, save: s.save });
    assert.equal(fine.ok, true);
  });
  test('an approved or shipped draft, a save that matches nothing, and an empty edit are all refused plainly', async () => {
    assert.equal((await editDraftContent({}, draft(OG, 'approved'), { title: 'x' }, { runGate: gateOk, save: async () => ({}) })).status, 409);
    assert.equal((await editDraftContent({}, draft(OG), { title: 'New title here' }, { runGate: gateOk, save: async () => null })).reason, 'not-saved');
    assert.equal((await editDraftContent({}, draft(OG), {}, { runGate: gateOk, save: async () => ({}) })).reason, 'no-change');
  });
});

describe('"tell the writer what to change"', () => {
  const deps = (s, callJson) => ({ runGate: gateOk, save: s.save, callJson });
  test('the writer rewrites just that field as asked; the other fields and the structure are untouched; it is saved through the same checks', async () => {
    const s = saver(); let seen;
    const r = await rewriteDraftField({}, draft(OG), { path: 'description', instruction: 'make it shorter and friendlier' }, deps(s, async (system, user) => { seen = { system, user }; return { text: 'Everything a salon needs.' }; }));
    assert.equal(r.ok, true);
    assert.equal(s.saved[0].description, 'Everything a salon needs.');
    assert.equal(s.saved[0].title, OG.title);
    assert.match(seen.user, /make it shorter and friendlier/);
    assert.match(seen.user, /Bookings, staff and payments in one place\./);
    assert.ok(!seen.user.includes('Zennly: salon and spa software'), 'only that field is sent');
    assert.match(seen.system, /Never add a statistic/);
  });
  test('a rewrite that adds a number nothing supports is refused and nothing is saved', async () => {
    const s = saver();
    const r = await rewriteDraftField({}, draft(BLOG), { path: 'quickAnswer', instruction: 'make it more convincing' }, deps(s, async () => ({ text: 'We improve results by 312% in 9 days.' })));
    assert.equal(r.ok, false);
    assert.equal(r.issues[0].rule, 'ungrounded-claim');
    assert.equal(s.saved.length, 0);
  });
  test('no instruction, an unknown field, an empty rewrite, and the worker being offline are each refused plainly', async () => {
    const s = saver();
    assert.equal((await rewriteDraftField({}, draft(OG), { path: 'description', instruction: '  ' }, deps(s, async () => ({ text: 'x' })))).reason, 'no-instruction');
    assert.equal((await rewriteDraftField({}, draft(OG), { path: 'image', instruction: 'x' }, deps(s, async () => ({ text: 'x' })))).reason, 'no-such-field');
    assert.equal((await rewriteDraftField({}, draft(OG), { path: 'title', instruction: 'x' }, deps(s, async () => ({ text: '  ' })))).reason, 'bad-edit');
    const off = await rewriteDraftField({}, draft(OG), { path: 'title', instruction: 'x' }, deps(s, async () => { throw Object.assign(new Error('offline'), { workerUnavailable: true }); }));
    assert.equal(off.status, 503);
    assert.match(off.error, /type the new wording yourself/);
    assert.equal(s.saved.length, 0);
  });
});

describe('only a claim an edit introduces blocks it', () => {
  test('a claim already in the old text does not stop an unrelated change to it; a new one does', async () => {
    const withOld = { title: 'T', quickAnswer: 'Over 90% of clients agree. Plain words here.', groundingContext: '', sections: [{ heading: 'One', body: 'Text.' }] };
    const ok = await editDraftContent({}, draft(withOld), { quickAnswer: 'Over 90% of clients agree. Other plain words here.' }, { runGate: gateOk, save: saver().save });
    assert.equal(ok.ok, true, `${ok.error || ''}`);
    const bad = await editDraftContent({}, draft({ ...withOld, quickAnswer: 'Plain words here.' }), { quickAnswer: 'Over 90% of clients agree. Plain words here.' }, { runGate: gateOk, save: saver().save });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'quality-gate');
  });
});

describe('drafts that are structure, not wording', () => {
  test('a schema or redirect draft offers nothing to edit even though it has keys called name and description', () => {
    const jsonLd = { jsonLd: { '@type': 'Organization', name: 'Acme', description: 'Maker of things' }, name: 'x' };
    assert.ok(editableFields(jsonLd).length > 0, 'without a type the old behaviour is unchanged');
    assert.deepEqual(editableFields(jsonLd, 'schema'), []);
    assert.deepEqual(editableFields(jsonLd, 'schema-repair'), []);
    assert.ok(editableFields({ title: 'A title' }, 'meta-title').length === 1, 'wording drafts are still editable');
  });
  test('an edit to a structural draft is refused', async () => {
    const r = await editDraftContent({}, { id: 1, status: 'submitted_for_approval', action_type: 'schema', content: { name: 'Acme' } }, { name: 'Other' }, { runGate: gateOk, save: saver().save });
    assert.equal(r.ok, false);
  });
});
