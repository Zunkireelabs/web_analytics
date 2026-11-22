import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForMatch, matchLinksPresent, matchSchemaState, matchMetaTags, extractLinks } from './verification-matchers.js';

describe('normalizeForMatch', () => {
  test('entities, JS escapes, curly quotes and whitespace all collapse to one form', () => {
    assert.equal(normalizeForMatch('Visa &amp; Study — it\\\'s  “free”'), `visa & study - it's "free"`);
    assert.equal(normalizeForMatch('caf&#233;'), 'café');
  });
});

describe('internal-links: a link to the target WITH the anchor, never the rationale', () => {
  const expected = { links: [{ href: 'https://site.test/study-in-uk/', anchor: 'study in the UK' }], origin: 'https://site.test' };
  test('passes when the anchor links to the target (relative href, trailing slash and case differences ignored)', () => {
    assert.equal(matchLinksPresent('<p>Learn to <a class="x" href="/Study-in-UK">Study in the UK</a> today.</p>', expected).present, true);
  });
  test('passes for markdown and JSX forms', () => {
    assert.equal(matchLinksPresent('See [study in the UK](/study-in-uk/).', expected).present, true);
    assert.equal(matchLinksPresent('<a href={"/study-in-uk"}>Study in the UK</a>', expected).present, true);
  });
  test('fails when the text is there but is not a link, or the link points elsewhere', () => {
    assert.equal(matchLinksPresent('<p>study in the UK</p>', expected).present, false);
    assert.equal(matchLinksPresent('<a href="/other/">study in the UK</a>', expected).present, false);
    assert.equal(matchLinksPresent('<a href="/study-in-uk/">click here</a>', expected).present, false);
  });
  test('a rationale sentence in the content proves nothing', () => {
    const html = '<p>This anchors the page to a high-intent destination.</p>';
    assert.equal(matchLinksPresent(html, expected).present, false);
  });
  test('nothing recorded -> cannot tell', () => assert.equal(matchLinksPresent('<a href="/x">y</a>', { links: [] }).present, null));
  test('extractLinks reads both syntaxes', () => assert.equal(extractLinks('<a href="/a">A</a> [b](/b)').length, 2));
});

describe('schema-repair: judged on the structured data, not a JSON slice', () => {
  const ld = (o) => `<script type="application/ld+json">${typeof o === 'string' ? o : JSON.stringify(o)}</script>`;
  test('remove-duplicate passes when exactly one block of the type remains, however it is serialised', () => {
    const html = ld({ '@type': 'LocalBusiness', name: 'A' }) + ld({ '@type': 'Organization' });
    assert.equal(matchSchemaState(html, { fixType: 'remove-duplicate', duplicateType: 'LocalBusiness' }).present, true);
  });
  test('remove-duplicate fails while two remain, and when both were removed', () => {
    const two = ld({ '@type': 'LocalBusiness' }) + ld({ '@type': 'LocalBusiness' });
    assert.equal(matchSchemaState(two, { fixType: 'remove-duplicate', duplicateType: 'LocalBusiness' }).present, false);
    assert.equal(matchSchemaState(ld({ '@type': 'Organization' }), { fixType: 'remove-duplicate', duplicateType: 'LocalBusiness' }).present, false);
  });
  test('counts typed nodes inside @graph too', () => {
    const html = ld({ '@graph': [{ '@type': 'LocalBusiness' }, { '@type': 'LocalBusiness' }] });
    assert.equal(matchSchemaState(html, { fixType: 'remove-duplicate', duplicateType: 'LocalBusiness' }).present, false);
  });
  test('templated source (no parseable block): the removed text must be gone, otherwise cannot-tell is NOT a pass', () => {
    const exp = { fixType: 'remove-duplicate', duplicateType: 'Thing', originalRaw: '{"@type":"Thing","a":2}' };
    assert.equal(matchSchemaState('<Layout/> text', exp).present, true);
    assert.equal(matchSchemaState('x {"@type":"Thing","a":2} y', exp).present, false);
  });
  test('repair-malformed needs every block to parse and the repaired object present (key order irrelevant only as parsed)', () => {
    const fixed = { '@type': 'Organization', name: 'A' };
    assert.equal(matchSchemaState(ld(fixed), { fixType: 'repair-malformed', jsonLd: fixed }).present, true);
    assert.equal(matchSchemaState(ld('{"@type": "Organization", name: oops}'), { fixType: 'repair-malformed', jsonLd: fixed }).present, false);
    assert.equal(matchSchemaState('no schema here', { fixType: 'repair-malformed', jsonLd: fixed }).present, null);
  });
});

describe('meta-title: whole title and whole description, after normalisation', () => {
  const exp = { title: 'Study in the UK from Nepal | Admizz', description: "Plan your UK study journey: costs, visas & intakes — it's easier with us." };
  test('live HTML with entities and a different escape style still matches', () => {
    const html = `<title>Study in the UK from Nepal | Admizz</title><meta name="description" content="Plan your UK study journey: costs, visas &amp; intakes — it&#39;s easier with us.">`;
    assert.equal(matchMetaTags(html, exp).present, true);
  });
  test('JS source with escaped quotes matches', () => {
    const src = `export const metadata = { title: 'Study in the UK from Nepal | Admizz', description: 'Plan your UK study journey: costs, visas & intakes — it\\'s easier with us.' };`;
    assert.equal(matchMetaTags(src, exp).present, true);
  });
  test('the description appearing in the BODY but not in the meta tag does not pass on live HTML', () => {
    const html = `<title>Study in the UK from Nepal | Admizz</title><meta name="description" content="Something else entirely"><p>${exp.description}</p>`;
    assert.equal(matchMetaTags(html, exp).present, false);
  });
  test('a different title fails; nothing recorded -> cannot tell', () => {
    assert.equal(matchMetaTags('<title>Other</title>', { title: 'Study in the UK' }).present, false);
    assert.equal(matchMetaTags('x', {}).present, null);
  });
});
