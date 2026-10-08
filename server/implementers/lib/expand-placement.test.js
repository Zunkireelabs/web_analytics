import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refineMarkerPlacement, placementOffset, classifyBlock } from './expand-placement.js';

const M = 'EXPAND';
const marker = '<!-- SEOAI:EXPAND:START --><!-- SEOAI:EXPAND:END -->';
const jsxMarker = '{/* SEOAI:EXPAND:START */}{/* SEOAI:EXPAND:END */}';
const ROLES = ['faq', 'cta'];
const place = (body, file = 'page.njk', m = marker) => refineMarkerPlacement(body + `\n${m}\n`, file, M, ROLES);

// where the marker sits, as the text that comes right after it
const after = (content, m = marker) => content.slice(content.indexOf(m) + m.length).replace(/\s+/g, ' ').trim();

describe('classifyBlock', () => {
  test('recognises faq and cta wording, not ordinary headings', () => {
    assert.equal(classifyBlock('Frequently asked questions', ROLES), 'faq');
    assert.equal(classifyBlock('Get in touch today', ROLES), 'cta');
    assert.equal(classifyBlock('Our visa process', ROLES), null);
  });
  test('only the roles asked about are matched', () => assert.equal(classifyBlock('FAQ', ['cta']), null));
});

describe('markup pages — HTML / templates', () => {
  const page = `<section class="hero"><h1>Study abroad</h1></section>
<section class="content"><h2>Why choose us</h2><p>text</p></section>
<section class="faq-section"><h2>FAQ</h2><details>q</details></section>
<section class="cta-banner"><h2>Get started</h2><a>Apply</a></section>`;

  test('the marker moves above the trailing FAQ and CTA sections', () => {
    const r = place(page);
    assert.equal(r.moved, true);
    assert.match(after(r.content), /^<section class="faq-section">/);
    // and the marker is after the content section
    assert.ok(r.content.indexOf(marker) > r.content.indexOf('Why choose us'));
  });

  test('a page with no trailing FAQ or CTA is left exactly as the engine placed it', () => {
    const plain = '<section><h2>One</h2></section>\n<section><h2>Two</h2></section>';
    const r = place(plain);
    assert.equal(r.moved, false);
    assert.equal(r.reason, 'no-trailing-faq-or-cta');
    assert.equal(r.content, `${plain}\n${marker}\n`);
  });

  test('only the TRAILING run moves it: an FAQ in the middle with content after it is not a boundary', () => {
    const mid = `<section><h2>FAQ</h2></section>\n<section><h2>More detail</h2></section>`;
    assert.equal(place(mid).moved, false);
  });

  test('an FAQ accordion NESTED in the content section is part of that section, not a trailing one', () => {
    const nested = `<section class="content"><h2>Details</h2><div class="faq-list"><details>q</details></div></section>`;
    assert.equal(place(nested).moved, false);
  });

  test('a div/class match counts as a block when it is positively an faq', () => {
    const divs = `<section><h2>Details</h2></section>\n<div class="faq-block"><h2>Questions</h2></div>`;
    const r = place(divs);
    assert.equal(r.moved, true);
    assert.match(after(r.content), /^<div class="faq-block">/);
  });

  test('the marker is never moved when the marker already existed on the page', () => {
    const body = `${page}\n${marker}\n`;
    const r = refineMarkerPlacement(body, 'page.njk', M, ROLES, { markerWasPresent: true });
    assert.deepEqual([r.moved, r.reason, r.content], [false, 'marker-already-on-page', body]);
  });

  test('removal and reinsertion are symmetric — no blank-line drift on repeat', () => {
    const once = place(page);
    const twice = refineMarkerPlacement(once.content, 'page.njk', M, ROLES);
    // a marker now sits before the FAQ already, so a second pass finds no
    // trailing run AFTER it and leaves it alone
    assert.equal(twice.content, once.content);
  });

  test('no marker in the text is reported, not thrown', () => {
    assert.equal(refineMarkerPlacement('<section></section>', 'a.njk', M, ROLES).reason, 'marker-not-found');
  });

  test('no roles means nothing to do', () => {
    assert.equal(refineMarkerPlacement(`${page}\n${marker}\n`, 'a.njk', M, []).moved, false);
  });
});

describe('JSX pages', () => {
  const jsx = `export default function P() {
  return (
    <main>
      <section><h2>About the course</h2></section>
      <Faq items={faqs} />
      <CTA title="Apply" />
    </main>
  );
}`;
  test('component-tag FAQ and CTA are recognised and the marker goes above them', () => {
    // The engine puts the marker before </main>; reproduce that.
    const withMarker = jsx.replace('    </main>', `      ${jsxMarker}\n    </main>`);
    const r = refineMarkerPlacement(withMarker, 'page.tsx', M, ROLES);
    assert.equal(r.moved, true);
    assert.match(after(r.content, jsxMarker), /^<Faq /);
  });
});

describe('markdown pages', () => {
  const md = `Intro paragraph.\n\n## Eligibility\n\nText.\n\n## Frequently asked questions\n\nQ\n\n## Get in touch\n\nCall us.`;
  test('the marker moves above the trailing FAQ and CTA headings', () => {
    const r = place(md, 'page.md');
    assert.equal(r.moved, true);
    assert.match(after(r.content), /^## Frequently asked questions/);
  });
  test('a markdown page that ends on ordinary content is untouched', () => {
    assert.equal(place('## One\n\ntext\n\n## Two\n\nmore', 'page.md').moved, false);
  });
});

describe('placementOffset — safety', () => {
  test('a block that still encloses the marker position is never used as an anchor', () => {
    // <section> opened and not closed before the marker: the marker is INSIDE it.
    const text = '<section class="faq"><h2>FAQ</h2><p>x';
    assert.equal(placementOffset(text, text.length, { roles: ROLES }), null);
  });
  test('an FAQ at the very start of the file is not a trailing run to hop above', () => {
    const text = '<section class="faq"><h2>FAQ</h2></section>';
    assert.equal(placementOffset(text, text.length, { roles: ROLES }), null);
  });
});
