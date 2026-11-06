import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCapabilities, discoverCapabilitiesIfNone, quoteAppearsOn } from './capability-discovery.js';

// The invariant worth protecting: nothing reaches the database as a fact. Everything is PROPOSED for a person to
// approve, and a capability whose supporting quote is not really on the page is dropped before storage — because an
// invented service, once approved by accident, then steers paid research and real content.

const site = { id: 7, website_domain: 'ourclinic.com' };
const pageText = 'Our Clinic in Pokhara. We offer teeth whitening, dental implants and emergency dental care. '
  + 'Our experienced dentists have served the community for fifteen years and we are open seven days a week. '
  + 'Book an appointment online or call us for a free consultation about your treatment options today.';

// The REAL shape: analyzePageUrl returns { ok, analysis: {...} }. A flat fake here is exactly how a reader of the wrong
// field passed its tests and then refused every real site.
function harness({ page = { ok: true, analysis: { title: 'Our Clinic', bodyText: pageText, headingOutline: [] } }, answer = null } = {}) {
  const calls = { proposed: [], asked: [] };
  return {
    calls,
    deps: {
      siteOriginFor: () => 'https://ourclinic.com',
      analyzePageUrl: async () => page,
      callLLMForJson: async (system, user) => { calls.asked.push(user); return answer; },
      proposeProductCapability: async (siteId, row) => { calls.proposed.push(row); return { id: calls.proposed.length }; },
    },
  };
}
const good = {
  capabilities: [
    { name: 'Teeth Whitening', category: 'dental', description: 'Whitening treatment.', evidence: 'We offer teeth whitening, dental implants and emergency dental care.' },
    { name: 'Dental Implants', category: 'dental', description: 'Implant treatment.', evidence: 'We offer teeth whitening, dental implants and emergency dental care.' },
  ],
};

describe('nothing is ever stored as verified', () => {
  test('found capabilities are proposed, with the quote that supports each one', async () => {
    const h = harness({ answer: good });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.ok, true);
    assert.equal(out.proposed, 2);
    assert.deepEqual(h.calls.proposed.map((r) => r.name), ['Teeth Whitening', 'Dental Implants']);
    assert.match(h.calls.proposed[0].details.evidence, /We offer teeth whitening/);
    assert.equal(h.calls.proposed[0].details.source, 'https://ourclinic.com');
  });

  test('a dry run finds them without writing anything', async () => {
    const h = harness({ answer: good });
    const out = await discoverCapabilities(site, { save: false, deps: h.deps });
    assert.equal(out.candidates.length, 2);
    assert.equal(out.proposed, 0);
    assert.equal(h.calls.proposed.length, 0);
  });
});

describe('a quote the page does not contain is dropped', () => {
  test('an invented service never reaches the database', async () => {
    const h = harness({
      answer: {
        capabilities: [
          ...good.capabilities,
          { name: 'Orthodontic Braces', description: 'Braces.', evidence: 'We are the leading provider of orthodontic braces in Nepal.' },
        ],
      },
    });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.deepEqual(out.candidates.map((c) => c.name), ['Teeth Whitening', 'Dental Implants']);
    assert.ok(!h.calls.proposed.some((r) => /Braces/.test(r.name)));
  });

  test('a capability with no quote at all is dropped', async () => {
    const h = harness({ answer: { capabilities: [{ name: 'Mystery Service', description: 'Something.' }] } });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.proposed, 0);
    assert.equal(out.skipped, 'nothing_clearly_offered');
  });

  test('punctuation and casing differences do not cause a false reject', () => {
    assert.equal(quoteAppearsOn('we offer TEETH WHITENING, dental implants', pageText), true);
    assert.equal(quoteAppearsOn('We  offer   teeth whitening!', pageText), true);
  });

  test('a quote too short to prove anything is rejected', () => {
    assert.equal(quoteAppearsOn('we offer', pageText), false);
    assert.equal(quoteAppearsOn('', pageText), false);
  });
});

describe('taglines and junk are not services', () => {
  test('a one-word name is dropped as a category or slogan fragment', async () => {
    const h = harness({ answer: { capabilities: [{ name: 'Dental', evidence: 'We offer teeth whitening, dental implants and emergency dental care.' }] } });
    assert.equal((await discoverCapabilities(site, { deps: h.deps })).proposed, 0);
  });

  test('an empty list from the model is the correct answer for a vague page, not a failure', async () => {
    const h = harness({ answer: { capabilities: [] } });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.ok, true);
    assert.equal(out.skipped, 'nothing_clearly_offered');
  });

  test('the candidate list is capped', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `Service Number ${i}`, evidence: 'We offer teeth whitening, dental implants and emergency dental care.',
    }));
    const h = harness({ answer: { capabilities: many } });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.candidates.length, 12);
  });
});

describe('refusing rather than guessing', () => {
  test('a site with no URL cannot be read', async () => {
    const h = harness({ answer: good });
    h.deps.siteOriginFor = () => null;
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.ok, false);
    assert.equal(out.skipped, 'no_site_url');
  });

  test('an unreachable page is reported, not guessed around', async () => {
    const h = harness({ page: { ok: false, error: 'timeout' }, answer: good });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.skipped, 'page_unreadable');
    assert.equal(h.calls.asked.length, 0, 'no model call for a page we could not read');
  });

  test('a near-empty page is refused before paying for a model call', async () => {
    const h = harness({ page: { ok: true, analysis: { title: 'Home', bodyText: 'Coming soon.', headingOutline: [] } }, answer: good });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.skipped, 'page_too_thin');
    assert.equal(h.calls.asked.length, 0);
  });

  test('a model failure degrades to nothing found, never to invented rows', async () => {
    const h = harness({ answer: null });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.ok, false);
    assert.equal(out.skipped, 'model_unavailable');
    assert.equal(h.calls.proposed.length, 0);
  });

  test('a store failure for one capability does not lose the others', async () => {
    const h = harness({ answer: good });
    let n = 0;
    h.deps.proposeProductCapability = async () => { n += 1; if (n === 1) throw new Error('db down'); return { id: n }; };
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.proposed, 1);
  });

  test('the page text, not a summary of it, is what the model is given', async () => {
    const h = harness({ answer: good });
    await discoverCapabilities(site, { deps: h.deps });
    assert.match(h.calls.asked[0], /We offer teeth whitening/);
  });
});

describe('discoverCapabilitiesIfNone — the arrival case', () => {
  test('a site that has described nothing is read', async () => {
    const h = harness({ answer: good });
    h.deps.getProductCapabilities = async () => [];
    const out = await discoverCapabilitiesIfNone(site, { deps: h.deps });
    assert.equal(out.proposed, 2);
  });

  test('a site with ANY capability, in any state, is left alone and no model call is made', async () => {
    for (const status of ['verified', 'proposed', 'rejected']) {
      const h = harness({ answer: good });
      h.deps.getProductCapabilities = async () => [{ id: 1, status }];
      const out = await discoverCapabilitiesIfNone(site, { deps: h.deps });
      assert.equal(out.skipped, 'already_has_capabilities', status);
      assert.equal(h.calls.asked.length, 0, `no paid call when a ${status} row exists`);
      assert.equal(h.calls.proposed.length, 0);
    }
  });

  test('if the existing list cannot be checked, it does not guess and add to it', async () => {
    const h = harness({ answer: good });
    h.deps.getProductCapabilities = async () => { throw new Error('db down'); };
    const out = await discoverCapabilitiesIfNone(site, { deps: h.deps });
    assert.equal(out.skipped, 'could_not_check_existing');
    assert.equal(h.calls.asked.length, 0);
  });
});

describe('the page reader\'s real return shape', () => {
  test('fields are read from .analysis, so a real page is not refused as too thin', async () => {
    const h = harness({ answer: good });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.notEqual(out.skipped, 'page_too_thin');
    assert.equal(out.proposed, 2);
  });

  test('a result with the fields on the wrong level is read as empty, not as content', async () => {
    // What the old code assumed. It must NOT be accepted as a readable page.
    const h = harness({ page: { ok: true, title: 'Our Clinic', bodyText: pageText, headingOutline: [] }, answer: good });
    const out = await discoverCapabilities(site, { deps: h.deps });
    assert.equal(out.skipped, 'page_too_thin');
  });
});
