import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
// store/read.js (pulled in by cta-analysis.js) needs a database — stub only
// what is imported, same convention as content-integrity.test.js.
mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => null, getSearchPerformanceRange: async () => [], getSearchPerformanceForPages: async () => [] } });

const { extractCtaCandidates, checkDestination } = await import('./cta-analysis.js');
const { VERDICT } = await import('./lib/verdict.js');

describe('extractCtaCandidates', () => {
  test('evaluates <a href> CTAs', () => {
    const c = extractCtaCandidates('<a href="/demo">Book a demo</a>');
    assert.deepEqual(c, [{ text: 'Book a demo', href: '/demo', kind: 'link' }]);
  });
  test('a <button> inside a form or with a handler/id is not a candidate', () => {
    const html = '<form><button>Get started</button></form><button onclick="x()">Sign up</button><button id="cta">Contact us</button><button type="submit">Get a quote</button>';
    assert.deepEqual(extractCtaCandidates(html), []);
  });
  test('a "#" anchor with a click handler is JS-driven, not a dead end', () => {
    assert.deepEqual(extractCtaCandidates('<a href="#" data-toggle="modal">Book a demo</a><a href="#" x-on:click="open=true">Sign up</a>'), []);
  });
  test('a bare handler-less button outside a form is the only button candidate', () => {
    const c = extractCtaCandidates('<button>Get started</button>');
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'button');
  });
});

describe('checkDestination', () => {
  const ok = async () => ({ ok: true });
  test('mailto: and tel: are not defects', async () => {
    assert.equal((await checkDestination('mailto:a@b.co', 'https://x.com', ok)).ok, true);
    assert.equal((await checkDestination('tel:+1555', 'https://x.com', ok)).ok, true);
  });
  test('a handler-less button is unverifiable, never "goes nowhere"', async () => {
    const r = await checkDestination(null, 'https://x.com', ok);
    assert.equal(r.ok, false);
    assert.equal(r.verdict, VERDICT.UNVERIFIABLE);
  });
  test('an external CTA answering 403/429 to bots is unverifiable, not "did not load"', async () => {
    const r = await checkDestination('https://calendly.com/x', 'https://x.com', async () => ({ ok: false, error: 'access denied' }));
    assert.equal(r.verdict, VERDICT.UNVERIFIABLE);
    assert.doesNotMatch(r.reason, /did not load/);
  });
  test('a clean 404 is confirmed', async () => {
    const r = await checkDestination('/gone', 'https://x.com', async () => ({ ok: false, error: 'not found' }));
    assert.equal(r.verdict, VERDICT.CONFIRMED);
  });
  test('a non-HTML destination (PDF) is fine', async () => {
    assert.equal((await checkDestination('/brochure.pdf', 'https://x.com', async () => ({ ok: false, error: 'not HTML' }))).ok, true);
  });
  test('a "#" href with nothing else is confirmed dead', async () => {
    assert.equal((await checkDestination('#', 'https://x.com', ok)).verdict, VERDICT.CONFIRMED);
  });
});
