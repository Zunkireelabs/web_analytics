import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFaqCapableTemplate, describeTemplate, deriveFaqDesignOptions, hasDesignOptions, designOptionsFor, validateDesignPick } from './fix-design-options.js';

// The real shape of the two FAQ-capable templates two of the projects store (class names shortened).
const FAQ = { wrapper: '<dl class="container-custom">\n{{ROWS}}\n</dl>', row: '  <dt class="text-2xl">{{QUESTION}}</dt>\n  <dd class="text-lg">{{ANSWER}}</dd>' };
const QA = { wrapper: '<div class="stack">\n{{ROWS}}\n</div>', row: '  <details>\n    <summary>\n      <h3 class="text-2xl">{{QUESTION}}</h3>\n    </summary>\n    <div class="body">{{ANSWER}}</div>\n  </details>' };
const LINKS = { wrapper: '<ul>{{ROWS}}</ul>', row: '<li><a href="{{URL}}">{{ANCHOR_TEXT}}</a></li>' };

test('a template can show FAQ items only if its row takes a question and an answer and its wrapper takes the rows', () => {
  assert.equal(isFaqCapableTemplate(FAQ), true);
  assert.equal(isFaqCapableTemplate(QA), true);
  assert.equal(isFaqCapableTemplate(LINKS), false, 'related links cannot show questions');
  assert.equal(isFaqCapableTemplate({ row: '{{QUESTION}} {{ANSWER}}', wrapper: '<div></div>' }), false, 'no {{ROWS}} slot');
  assert.equal(isFaqCapableTemplate(null), false);
});

test('a template is described from its own markup, in plain words', () => {
  assert.equal(describeTemplate(QA).shape, 'accordion');
  assert.equal(describeTemplate(FAQ).shape, 'list');
  assert.equal(describeTemplate({ row: '<h3>{{QUESTION}}</h3><p>{{ANSWER}}</p>', wrapper: '{{ROWS}}' }).shape, 'headings');
});

test('options are the site\'s own FAQ-capable templates, and only when there is a real choice', () => {
  const two = deriveFaqDesignOptions({ faq: FAQ, qaContent: QA, internalLinks: LINKS });
  assert.deepEqual(two.map((o) => [o.key, o.shape]), [['faq', 'list'], ['qaContent', 'accordion']]);
  assert.match(two[0].note, /your site's own "faq" component/i);
  assert.equal(two[0].tag, 'Your usual FAQ style');
  assert.deepEqual(deriveFaqDesignOptions({ faq: FAQ }), [], 'one template is not a choice');
  assert.deepEqual(deriveFaqDesignOptions({ internalLinks: LINKS, expandContent: LINKS }), [], 'a site with no FAQ template (Admizz) has nothing to choose');
  assert.deepEqual(deriveFaqDesignOptions({ faq: FAQ, qaContent: { ...FAQ } }), [], 'two templates that look the same are not two choices');
  assert.deepEqual(deriveFaqDesignOptions(undefined), []);
});

test('only FAQ blocks can need a design choice; everything else has no options', () => {
  assert.equal(hasDesignOptions('faq'), true);
  for (const g of ['internal-links', 'security-headers', 'schema', 'canonical', 'meta-title']) { assert.equal(hasDesignOptions(g), false, g); assert.deepEqual(designOptionsFor(g, { faq: FAQ, qaContent: QA }), [], g); }
  assert.equal(designOptionsFor('faq', { faq: FAQ, qaContent: QA }).length, 2);
});

const row = (over = {}) => ({ status: 'needs_choice', options: deriveFaqDesignOptions({ faq: FAQ, qaContent: QA }), ...over });
test('a pick is valid only for an open row and one of the options it was offered', () => {
  assert.deepEqual(validateDesignPick(row(), 'qaContent'), { ok: true });
  assert.deepEqual(validateDesignPick(row({ status: 'chosen' }), 'faq'), { ok: true }, 'a choice can be changed until the run has it');
  assert.equal(validateDesignPick(row(), 'expandContent').status, 400, 'a template the site was not offered');
  assert.equal(validateDesignPick(row({ status: 'building' }), 'faq').status, 409);
  assert.equal(validateDesignPick(null, 'faq').status, 404);
});

test('each option carries a picture of the site\'s real block, styled by its own class rules', async () => {
  const { deriveFaqDesignOptions } = await import('./fix-design-options.js');
  const tpl = {
    faq: { row: '<dt class="q">{{QUESTION}}</dt><dd>{{ANSWER}}</dd>', wrapper: '<dl class="wrap">{{ROWS}}</dl>', verifiedClassRules: { q: 'font-size:2rem', 'md:wrap': 'padding:5rem' } },
    qaContent: { row: '<details><summary>{{QUESTION}}</summary><div>{{ANSWER}}</div></details><script>x()</script>', wrapper: '<div>{{ROWS}}</div>' },
  };
  const [a, b] = deriveFaqDesignOptions(tpl);
  assert.match(a.previewHtml, /\.q\{font-size:2rem\}/);
  assert.match(a.previewHtml, /@media\(min-width:768px\)\{\.md\\:wrap\{padding:5rem\}\}/);
  assert.match(b.previewHtml, /<details open>/, 'the accordion shows its first item open');
  assert.ok(!/<script/i.test(b.previewHtml.split('</style>')[1]), 'no executable markup from the template is kept');
  assert.notEqual(a.previewHtml, b.previewHtml);
});
