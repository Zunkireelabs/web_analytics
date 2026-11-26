import test from 'node:test';
import assert from 'node:assert/strict';
import { faqBlockTemplate, learnHtmlFaqTemplate } from './html-faq-learn.js';
import { renderFaqHtml } from '../../implementers/lib/marker-merge.js';

const fm = '---\ntitle: "T"\n---\n';
const qa = [['What is it?', 'It is a thing.'], ['Why use it?', 'Because it helps.'], ['How much?', 'Nothing.']];

// The three shapes real sites use for a post's FAQ, built from invented text.
const card = (items) => `<!-- SEOAI:FAQ:START --><div class="mt-10 p-6 bg-gray-50 rounded-lg"><h3 class="text-2xl mb-6">Frequently asked questions</h3><div class="space-y-6">${items.map(([q, a]) => `<div><p class="text-lg font-medium mb-2">${q}</p><p class="text-gray-600">${a}</p></div>`).join('')}</div></div><!-- SEOAI:FAQ:END -->`;
const details = (items) => `<section class="faq"><h2>Frequently asked questions</h2>${items.map(([q, a]) => `<details class="faq-item"><summary>${q}</summary><p>${a}</p></details>`).join('\n')}</section>`;
const dl = (items) => `<div class="faq-box"><h2>FAQ</h2><dl class="faq-list">${items.map(([q, a]) => `<dt class="q">${q}</dt><dd class="a">${a}</dd>`).join('')}</dl></div>`;
const post = (blockFn, items = qa) => `${fm}\n## Heading\n\nBody text.\n\n${blockFn(items)}\n`;

test('a marked card FAQ: wrapper and row are learned, and the proof reproduces the post\'s own block', () => {
  const t = faqBlockTemplate(post(card));
  assert.ok(t); assert.equal(t.items, 3);
  assert.match(t.wrapper, /^<div class="mt-10 p-6 bg-gray-50 rounded-lg"><h3 class="text-2xl mb-6">Frequently asked questions<\/h3><div class="space-y-6">\{\{ROWS\}\}<\/div><\/div>$/);
  assert.equal(t.row, '<div><p class="text-lg font-medium mb-2">{{QUESTION}}</p><p class="text-gray-600">{{ANSWER}}</p></div>');
});
test('an unmarked details/summary FAQ under a "Frequently asked questions" heading', () => {
  const t = faqBlockTemplate(post(details));
  assert.ok(t); assert.match(t.row, /<details class="faq-item"><summary>\{\{QUESTION\}\}<\/summary><p>\{\{ANSWER\}\}<\/p><\/details>/);
});
test('a definition list: each dt+dd is one row', () => {
  const t = faqBlockTemplate(post(dl));
  assert.ok(t); assert.equal(t.row, '<dt class="q">{{QUESTION}}</dt><dd class="a">{{ANSWER}}</dd>'); assert.match(t.wrapper, /<dl class="faq-list">\{\{ROWS\}\}<\/dl>/);
});
test('a post with no FAQ gives nothing', () => { assert.equal(faqBlockTemplate(`${fm}\n## A\n\nText.\n`), null); });
test('different questions per post still give the same template', () => {
  const posts = [post(card), post(card, [['One?', 'Uno.'], ['Two?', 'Dos.']]), post(card, [['Q3?', 'A3.'], ['Q4?', 'A4.']])];
  const t = learnHtmlFaqTemplate(posts);
  assert.ok(t); assert.equal(t.learnedFrom, 3);
});
test('needs two posts that agree, and more than half of the posts that have one', () => {
  assert.equal(learnHtmlFaqTemplate([post(card)]), null);
  assert.equal(learnHtmlFaqTemplate([post(card), post(details)]), null);                     // two forms, no majority
  assert.ok(learnHtmlFaqTemplate([post(card), post(card), post(details)]));                  // two of three agree
});
test('markup that cannot be reproduced exactly is not used (no guessing)', () => {
  const odd = `${fm}\n<!-- SEOAI:FAQ:START --><div><h3>Frequently asked questions</h3><div><div><p>Q1?</p><p>A1 <b>bold</b> tail</p></div><div><p>Q2?</p><p>A2</p></div></div></div><!-- SEOAI:FAQ:END -->\n`;
  assert.equal(faqBlockTemplate(odd), null);
});

test('the post\'s own FAQPage JSON-LD inside the marker region is ignored: it differs per post and is not part of the design', () => {
  const withSchema = (items) => card(items).replace('<!-- SEOAI:FAQ:END -->', `<script type="application/ld+json">{"@type":"FAQPage","n":${items.length}}</script><!-- SEOAI:FAQ:END -->`);
  const posts = [post(withSchema), post(withSchema, qa.slice(0, 2)), post(withSchema, qa.slice(1))];
  const t = learnHtmlFaqTemplate(posts);
  assert.ok(t); assert.doesNotMatch(t.wrapper, /script|FAQPage/);
});

test('the platform\'s real FAQ renderer, given the learned template and a post\'s own questions, reproduces that post\'s own block', () => {
  const posts = [post(card), post(card, qa.slice(0, 2)), post(card, qa.slice(1))];
  const t = learnHtmlFaqTemplate(posts);
  const out = renderFaqHtml(qa.map(([question, answer]) => ({ question, answer })), t);
  const own = /<!-- SEOAI:FAQ:START -->([\s\S]*?)<!-- SEOAI:FAQ:END -->/.exec(card(qa))[1];
  assert.equal(out.replace(/\s+/g, ''), own.replace(/\s+/g, ''));
});
