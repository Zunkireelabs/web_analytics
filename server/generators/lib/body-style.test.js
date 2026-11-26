import test from 'node:test';
import assert from 'node:assert/strict';
import { bodySignature, bodyStyleFromSignatures } from './body-style.js';
import { renderBlogOutlineBody } from '../../implementers/lib/newpage-render.js';

const fm = '---\ntitle: "T"\ndate: 2026-01-01\n---\n';
const plainMd = `${fm}\n**Lead.** Text.\n\n## One\n\nBody [link](/x).\n\n## Two\n\nMore.\n`;                       // SuperRank: bare markdown
const chayce = `${fm}\n## One\n\nBody.\n\n<div class="post-help">\n<p class="post-help-links">Help</p>\n</div>\n`;     // Chayce: a closing block, not a wrapper
const zunkiree = `${fm}\n<div class="container-custom py-12 md:py-20">\n\n## One\n\nBody.\n\n</div>\n`;               // Zunkiree: one wrapper around the post
const classed = `${fm}\n<h2 class="big">One</h2>\n<p class="copy">Body</p>\n`;

test('bodySignature: bare markdown has no wrapper and no classed text', () => {
  assert.deepEqual(bodySignature(plainMd), { wrapper: null, classedProse: false });
});
test('bodySignature: a trailing block is not a wrapper', () => {
  assert.equal(bodySignature(chayce).wrapper, null);
});
test('bodySignature: one outer div around the whole post is the wrapper', () => {
  assert.deepEqual(bodySignature(zunkiree), { wrapper: 'container-custom py-12 md:py-20', classedProse: false });
});
test('bodySignature: classes on headings and paragraphs are noticed', () => {
  assert.equal(bodySignature(classed).classedProse, true);
});
test('bodyStyleFromSignatures: needs 3 posts, and more than half must agree', () => {
  assert.equal(bodyStyleFromSignatures([bodySignature(plainMd), bodySignature(plainMd)]), null);
  const z = [zunkiree, zunkiree, zunkiree, plainMd].map(bodySignature);
  assert.deepEqual(bodyStyleFromSignatures(z), { wrapper: 'container-custom py-12 md:py-20', classedProse: false, samples: 4 });
  const mixed = [zunkiree, plainMd, plainMd, chayce].map(bodySignature);
  assert.equal(bodyStyleFromSignatures(mixed).wrapper, null); // one odd post decides nothing
});

// A site whose design profile (taken from its LANDING pages) carries section-scale classes.
const profile = { typography: { heading: { section: 'h2', item: 'h2' }, body: 'lead', link: 'link-arrow' }, pageWrapper: '<div class="container section">{{BODY}}</div>' };
const site = { id: 1, url_file_map: { siteRoot: { designProfile: profile } } };
const content = { title: 'T', topic: 't', sections: [{ heading: 'One', body: 'Para with a [link](/x).' }, { heading: 'Two', body: 'More.' }] };
const render = (bodyStyle) => renderBlogOutlineBody(content, site, { permalink: '/blog/t/', bodyStyle });

test('the blog follows its own posts: bare-markdown siblings give a body with no wrapper and no classes', () => {
  const out = render(bodyStyleFromSignatures([plainMd, plainMd, plainMd].map(bodySignature)));
  assert.doesNotMatch(out, /class=/);
  assert.match(out, /## One/);
});
test('the blog follows its own posts: siblings that share a wrapper get exactly that wrapper, with nothing added', () => {
  const out = render(bodyStyleFromSignatures([zunkiree, zunkiree, zunkiree].map(bodySignature)));
  assert.match(out, /<div class="container-custom py-12 md:py-20">/);
  assert.doesNotMatch(out, /max-w-2xl|container section|class="h2"|lead|link-arrow/);
});
test('with too little to go on (no bodyStyle) the old behaviour is unchanged', () => {
  const out = render(null);
  assert.match(out, /<h2 class="h2">/);   // the design profile's classes are still projected when nothing was learned from the posts
});

test('a classed FAQ block inside the post does not make the article prose "classed" (Zunkiree posts)', () => {
  const withFaq = `${fm}\n<div class="container-custom py-12 md:py-20">\n\n## One\n\nBody.\n\n<div class="faq">\n<h3 class="text-2xl">Q?</h3>\n<p class="text-gray-600">A</p>\n</div>\n\n</div>\n`;
  assert.deepEqual(bodySignature(withFaq), { wrapper: 'container-custom py-12 md:py-20', classedProse: false });
});
