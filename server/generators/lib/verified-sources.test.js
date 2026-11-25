import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedHost, claimSupported, verifySource, buildVerifiedSources } from './verified-sources.js';

const page = (title, bodyText, extra = {}) => async () => ({ ok: true, analysis: { title, bodyText, wasRedirected: false, ...extra } });
const CLAIM = 'Stamp duty land tax applies to residential property purchases above the nil rate threshold in England';
const TEXT = 'Stamp Duty Land Tax: residential property rates. You pay Stamp Duty Land Tax on purchases above the nil rate threshold in England and Northern Ireland.';

describe('isTrustedHost', () => {
  test('government, education and intergovernmental domains are trusted anywhere', () => {
    for (const h of ['www.gov.uk', 'hmrc.gov.uk', 'www.nhs.uk', 'ox.ac.uk', 'mit.edu', 'ec.europa.eu', 'en.wikipedia.org', 'who.int', 'immigration.gov.np']) assert.equal(isTrustedHost(h), true, h);
  });
  test('a random blog, a look-alike domain and a bare word are not', () => {
    for (const h of ['myblog.com', 'gov.uk.evil.com', 'notwikipedia.org', 'localhost', '', 'fakegov.uk']) assert.equal(isTrustedHost(h), false, h);
  });
  test('a domain the site itself lists is trusted, with its subdomains', () => {
    assert.equal(isTrustedHost('www.rics.org', ['rics.org']), true);
    assert.equal(isTrustedHost('data.rics.org', ['rics.org']), true);
    assert.equal(isTrustedHost('rics.org.evil.com', ['rics.org']), false);
  });
});

describe('claimSupported', () => {
  test('a page that states the claim supports it; an unrelated page, or a claim too vague to check, does not', () => {
    assert.equal(claimSupported(CLAIM, TEXT), true);
    assert.equal(claimSupported(CLAIM, 'Contact us about our opening hours and parking arrangements for visitors.'), false);
    assert.equal(claimSupported('It is good.', TEXT), false);
  });
});

describe('verifySource', () => {
  const good = { url: 'https://www.gov.uk/stamp-duty-land-tax/residential-property-rates', claim: CLAIM };
  test('a trusted, loading page that contains the claim is kept, labelled with the PAGE title, not the model wording', async () => {
    const r = await verifySource({ ...good, label: 'Totally made up label' }, { fetchPage: page('Stamp Duty Land Tax: residential property rates', TEXT) });
    assert.deepEqual(r, { ok: true, source: { label: 'Stamp Duty Land Tax: residential property rates', url: good.url } });
  });
  test('each way a source can be fake or wrong is refused, with the reason', async () => {
    const ok = page('T', TEXT);
    assert.equal((await verifySource({ ...good, url: 'http://www.gov.uk/x' }, { fetchPage: ok })).reason, 'not-https');
    assert.equal((await verifySource({ ...good, url: 'https://myblog.com/x' }, { fetchPage: ok })).reason, 'untrusted-host');
    assert.equal((await verifySource({ ...good, url: 'not a url' }, { fetchPage: ok })).reason, 'invalid-url');
    assert.equal((await verifySource({ url: good.url }, { fetchPage: ok })).reason, 'no-claim');
    assert.equal((await verifySource(good, { fetchPage: async () => ({ ok: false, error: 'HTTP 404' }) })).reason, 'fetch-failed');
    assert.equal((await verifySource(good, { fetchPage: async () => { throw new Error('boom'); } })).reason, 'fetch-failed');
    assert.equal((await verifySource(good, { fetchPage: page('T', TEXT, { wasRedirected: true }) })).reason, 'redirected');
    assert.equal((await verifySource(good, { fetchPage: page('', TEXT) })).reason, 'no-title');
    assert.equal((await verifySource(good, { fetchPage: page('Other', 'Opening hours and parking for visitors to the council offices.') })).reason, 'claim-not-on-page');
  });
});

describe('buildVerifiedSources', () => {
  const sections = [{ heading: 'Tax', body: CLAIM + '.' }];
  const fetchPage = async (url) => (url.includes('good') ? { ok: true, analysis: { title: 'Good page', bodyText: TEXT, wasRedirected: false } } : { ok: false, error: 'HTTP 404' });
  test('keeps only the verified ones, drops duplicates, and caps the list', async () => {
    const propose = async () => [
      { url: 'https://www.gov.uk/good-1', claim: CLAIM }, { url: 'https://www.gov.uk/good-1/', claim: CLAIM }, { url: 'https://www.gov.uk/missing', claim: CLAIM },
      { url: 'https://myblog.com/good-2', claim: CLAIM }, { url: 'https://www.gov.uk/good-3', claim: CLAIM }, { url: 'https://www.gov.uk/good-4', claim: CLAIM },
    ];
    const out = await buildVerifiedSources(sections, 'tax', { propose, fetchPage, max: 2 });
    assert.deepEqual(out.map((s) => s.url), ['https://www.gov.uk/good-1', 'https://www.gov.uk/good-3']);
  });
  test('never throws and never invents: bad proposals, a throwing proposer or an empty post give an empty list', async () => {
    assert.deepEqual(await buildVerifiedSources(sections, 't', { propose: async () => 'nonsense', fetchPage }), []);
    assert.deepEqual(await buildVerifiedSources(sections, 't', { propose: async () => { throw new Error('x'); }, fetchPage }), []);
    assert.deepEqual(await buildVerifiedSources([], 't', { propose: async () => [{ url: 'https://www.gov.uk/good', claim: CLAIM }], fetchPage }), []);
  });
});
