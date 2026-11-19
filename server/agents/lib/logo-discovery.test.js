import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { firstCandidate } from './logo-discovery.js';

// Markup copied from the real https://mobilise.agency/ (read 2026-11-19): the real logo sits in the header with alt "MOBILISE home"
// and no "logo" in any attribute, and the testimonial section is full of class="testi-logo" customer images.
const MOBILISE = `<html><head>
  <link rel="icon" href="./images/favicon.png" type="image/png">
  <link rel="apple-touch-icon" href="./images/favicon.png">
  <meta property="og:image" content="https://mobilise.agency/images/Thumbnail.jpg"></head><body>
  <header><nav><a href="/"><img src="./images/mobilise_new_logo.png" alt="MOBILISE home" width="1336" height="367" decoding="async"></a></nav></header>
  <section class="testimonials">
    <img src="./images/testimonials/salesforce.png" alt="Salesforce" class="testi-logo" loading="lazy">
    <img src="./images/testimonials/redhat.png" alt="Red Hat" class="testi-logo" loading="lazy">
  </section>
  <footer><img src="./images/mobilise_new_logo.png" alt="MOBILISE" class="footer-logo"></footer></body></html>`;

test('MOBILISE: picks its own logo (the footer one), not the Salesforce testimonial image', () => {
  const c = firstCandidate(cheerio.load(MOBILISE), 'https://mobilise.agency/');
  assert.equal(c.url, 'https://mobilise.agency/images/mobilise_new_logo.png');
  assert.equal(c.source, 'img.logo');
});

test('a header image with no "logo" in class, id or alt is NOT promoted (unchanged behaviour: favicon sites stay on the favicon)', () => {
  const html = '<html><head><link rel="apple-touch-icon" href="/touch.png"></head><body><header><img src="/img/acme-logo-wide.png" alt="Acme home"></header></body></html>';
  assert.equal(firstCandidate(cheerio.load(html), 'https://acme.com/').url, 'https://acme.com/touch.png');
});

test('only customer logos on the page: falls through to the touch icon, never a customer logo', () => {
  const html = '<html><head><link rel="apple-touch-icon" href="/touch.png"></head><body><section class="clients"><img src="/c/acme.png" class="client-logo" alt="Acme logo"></section></body></html>';
  const c = firstCandidate(cheerio.load(html), 'https://example.com/');
  assert.equal(c.url, 'https://example.com/touch.png');
  assert.equal(c.source, 'apple-touch-icon');
});

test('unchanged: a normal header img with class "logo" is still found first', () => {
  const html = '<html><body><header><img class="site-logo" src="/l.svg" alt="x"></header><img class="logo" src="/other.png"></body></html>';
  assert.equal(firstCandidate(cheerio.load(html), 'https://example.com/').url, 'https://example.com/l.svg');
});
