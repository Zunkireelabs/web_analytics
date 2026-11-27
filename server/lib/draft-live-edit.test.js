import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { editDraftBlock, previewDraftLive } from './draft-article-preview.js';

const draft = (over = {}) => ({
  id: 7, action_type: 'blog-outline', status: 'submitted_for_approval',
  content: { title: 'T', topic: 'T', quickAnswer: 'Short.', sections: [{ heading: 'One', body: 'Text one.' }], faqItems: [{ question: 'Q?', answer: 'A.' }], sources: [{ label: 'GOV.UK', url: 'https://www.gov.uk/x' }] },
  ...over,
});
const site = { id: 1 };
const passGate = async () => ({ clean: true, issues: [] });
const saver = () => { const saved = []; return { saved, save: async (content) => { saved.push(content); return { id: 7, content }; } }; };

describe('editing one block of a draft', () => {
  test('an instruction is rewritten by the worker, passes the gate, and only that block is saved', async () => {
    const s = saver();
    const r = await editDraftBlock(site, draft(), { blockId: 's:0', instruction: 'make it shorter' }, { runGate: passGate, save: s.save, callJson: async () => ({ heading: 'One', body: 'Short text.' }) });
    assert.equal(r.ok, true);
    assert.equal(s.saved[0].sections[0].body, 'Short text.');
    assert.equal(s.saved[0].quickAnswer, 'Short.');
    assert.equal(r.changed, 's:0');
  });
  test('typed text is saved without the worker', async () => {
    const s = saver();
    const r = await editDraftBlock(site, draft(), { blockId: 'faq:0', value: { question: 'Q?', answer: 'My own answer.' } }, { runGate: passGate, save: s.save, callJson: async () => { throw new Error('must not be called'); } });
    assert.equal(r.ok, true);
    assert.equal(s.saved[0].faqItems[0].answer, 'My own answer.');
  });
  test('a change that introduces a problem is not saved, and the reasons come back', async () => {
    const s = saver();
    let calls = 0;
    const gate = async () => (++calls === 1 ? { clean: true, issues: [] } : { clean: false, issues: [{ patternId: 'ungrounded-claim', detail: 'x' }] });
    const r = await editDraftBlock(site, draft(), { blockId: 'quick', value: 'We beat every rival.' }, { runGate: gate, save: s.save });
    assert.equal(r.ok, false);
    assert.equal(r.status, 422);
    assert.equal(r.issues[0].rule, 'ungrounded-claim');
    assert.equal(s.saved.length, 0);
  });
  test('problems the draft already had do not stop an unrelated edit; a new one still does', async () => {
    const old = { patternId: 'blog-title-length', detail: 'The title is 96 characters' };
    const s = saver();
    const ok = await editDraftBlock(site, draft(), { blockId: 'quick', value: 'A plain new short answer.' }, { runGate: async () => ({ clean: false, issues: [old] }), save: s.save });
    assert.equal(ok.ok, true);
    assert.equal(s.saved.length, 1);
    let calls = 0;
    const gate = async () => (++calls === 1 ? { clean: false, issues: [old] } : { clean: false, issues: [old, { patternId: 'competitor-link', detail: 'links a rival' }] });
    const bad = await editDraftBlock(site, draft(), { blockId: 'quick', value: 'See rival.com' }, { runGate: gate, save: s.save });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.issues.map((i) => i.rule), ['competitor-link']);
    assert.equal(s.saved.length, 1);
  });
  test('a number nothing supports is stopped in the short answer and in a FAQ answer, but a supported one is fine', async () => {
    const deps = (s) => ({ runGate: passGate, save: s.save });
    const withGrounding = (c) => draft({ content: { ...draft().content, groundingContext: 'The team has helped 2,000 students enrol.' } });
    const s = saver();
    const quick = await editDraftBlock(site, withGrounding(), { blockId: 'quick', value: 'We improve results by 312% in 9 days.' }, deps(s));
    assert.equal(quick.ok, false);
    assert.equal(quick.issues[0].rule, 'ungrounded-claim');
    const faq = await editDraftBlock(site, withGrounding(), { blockId: 'faq:0', value: { question: 'Does it work?', answer: 'Yes, 87% of customers see results.' } }, deps(s));
    assert.equal(faq.ok, false);
    assert.equal(s.saved.length, 0);
    const fine = await editDraftBlock(site, withGrounding(), { blockId: 'quick', value: 'We have helped 2,000 students enrol.' }, deps(s));
    assert.equal(fine.ok, true);
  });
  test('a save that matches no draft is a failure, not a success with nothing saved', async () => {
    const r = await editDraftBlock(site, draft(), { blockId: 'quick', value: 'A plain new short answer.' }, { runGate: passGate, save: async () => null });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.reason, 'not-saved');
  });
  test('an approved or shipped draft cannot be edited', async () => {
    const r = await editDraftBlock(site, draft({ status: 'approved' }), { blockId: 'quick', value: 'x' }, { runGate: passGate, save: async () => {} });
    assert.equal(r.status, 409);
  });
  test('the sources, an unknown block and a missing instruction are refused with a plain reason', async () => {
    const deps = { runGate: passGate, save: async () => {} };
    assert.equal((await editDraftBlock(site, draft(), { blockId: 'sources', value: [] }, deps)).reason, 'not-editable-block');
    assert.equal((await editDraftBlock(site, draft(), { blockId: 's:9', value: {} }, deps)).reason, 'no-such-block');
    assert.equal((await editDraftBlock(site, draft(), { blockId: 'quick' }, deps)).reason, 'no-instruction');
  });
  test('worker offline: a clear message to try again or type the text, nothing saved', async () => {
    const s = saver();
    const r = await editDraftBlock(site, draft(), { blockId: 'quick', instruction: 'shorter' }, { runGate: passGate, save: s.save, callJson: async () => { throw Object.assign(new Error('offline'), { workerUnavailable: true }); } });
    assert.equal(r.status, 503);
    assert.match(r.error, /type the new text yourself/);
    assert.equal(s.saved.length, 0);
  });
  test('only blog posts are previewed and edited here', async () => {
    assert.equal((await previewDraftLive(site, { action_type: 'meta-title', content: { title: 'x' } })).reason, 'not-an-article');
    assert.equal((await editDraftBlock(site, { action_type: 'faq', status: 'draft', content: {} }, { blockId: 'quick' }, {})).reason, 'not-an-article');
  });
});
