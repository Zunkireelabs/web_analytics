import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { learnMarkdownConventions, renderMarkdownNative, placeMarkdownMarker, planMarkdownTitleField, ownClosingHeading, expandedContentBelowClosingSection } from './markdown-native.js';
import { hasMarkdownFaqSection, hasFaqClassedSection, extractMarkdownFaqItems } from '../../lib/existing-faq.js';

// Shapes copied from a real Astro blog collection (2026-11-23 incident): most posts write their FAQ as
// "## Frequently asked questions" + **Question?** paragraphs and end with "## Related guides" + "- [t](u): note".
const post = (extra = '') => `---\ntitle: "A post"\nseoTitle: "A post | Brand"\n---\n\nIntro.\n\n## Body\n\nText.\n${extra}`;
const faqBold = '\n## Frequently asked questions\n\n**Is it free?** Yes, for 14 days.\n\n**Do I need a developer?** Sometimes.\n';
const related = '\n## Related guides\n- [Guide one](/blog/one): The first guide.\n- [Guide two](/blog/two): The second guide.\n';
const marker = (n) => `<!-- SEOAI:${n}:START --><!-- SEOAI:${n}:END -->`;
const SIBLINGS = [post(faqBold + related), post(faqBold + related), post(related + '\n| A | B |\n| --- | --- |\n| 1 | 2 |\n')];

describe('existing FAQ detection', () => {
  test('Markdown "## FAQ" / "## Quick FAQ" with questions counts; a lone FAQ word does not', () => {
    assert.equal(hasMarkdownFaqSection('## FAQ\n\n### Does it work?\n\nYes.'), true);
    assert.equal(hasMarkdownFaqSection('## Quick FAQ\n\n**How long?** An hour.'), true);
    assert.equal(hasMarkdownFaqSection('See our [FAQ](/faq) page.'), false);
    assert.equal(hasMarkdownFaqSection('## FAQ\n\nNothing here yet.\n\n## Next\n\n### Is this a question?'), false);
  });
  test('a faq-classed section with FAQ wording counts (e.g. class="faq-x")', () => {
    assert.equal(hasFaqClassedSection('<section class="faq-x"><h2>Frequently asked questions</h2></section>'), true);
    assert.equal(hasFaqClassedSection('<section class="hero"><h2>Hello</h2></section>'), false);
  });
  test('the page\'s own questions are read back verbatim, both formats', () => {
    assert.deepEqual(extractMarkdownFaqItems('## FAQ\n\n### Does it work?\n\nYes, it\ndoes.\n\n### Is it fast?\n\nVery.'),
      [{ question: 'Does it work?', answer: 'Yes, it does.' }, { question: 'Is it fast?', answer: 'Very.' }]);
    assert.deepEqual(extractMarkdownFaqItems(faqBold), [{ question: 'Is it free?', answer: 'Yes, for 14 days.' }, { question: 'Do I need a developer?', answer: 'Sometimes.' }]);
  });
});

describe('learnMarkdownConventions', () => {
  test('learns the heading, question style and position the site itself uses', () => {
    const c = learnMarkdownConventions(SIBLINGS);
    assert.deepEqual(c.faq, { heading: '## Frequently asked questions', level: 2, style: 'bold', before: '## Related guides' });
    assert.deepEqual(c.related, { heading: '## Related guides', withNote: true });
    assert.equal(c.usesTables, true);
  });
  test('no sibling with a FAQ → no FAQ convention (nothing to copy, nothing invented)', () => {
    assert.equal(learnMarkdownConventions([post(related)]).faq, null);
  });
});

describe('renderMarkdownNative', () => {
  const conv = learnMarkdownConventions(SIBLINGS);
  const items = [{ question: 'What is it?', answer: 'A tool.' }, { question: 'Who is it for?', answer: 'Teams.' }];

  test('a FAQ is written exactly the way the site writes one, placed above Related guides', () => {
    const r = renderMarkdownNative('faq', { items }, conv, { fileBody: post(related) });
    assert.equal(r.ok, true);
    assert.equal(r.value, '\n\n## Frequently asked questions\n\n**What is it?** A tool.\n\n**Who is it for?** Teams.\n\n');
    assert.equal(r.placeBefore, '## Related guides');
    assert.doesNotMatch(r.value, /<dl|<dt|<div|class=/);
  });
  test('never a second FAQ on a page that has its own (the incident)', () => {
    const r = renderMarkdownNative('faq', { items }, conv, { fileBody: post('\n## FAQ\n\n### Old question?\n\nOld answer.\n') });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'page-has-own-faq');
  });
  test('no FAQ anywhere in the collection → held, not invented', () => {
    const r = renderMarkdownNative('faq', { items }, learnMarkdownConventions([post(related)]), { fileBody: post() });
    assert.equal(r.reason, 'no-markdown-faq-convention');
  });
  test('related links join the page\'s existing list, in its own item format', () => {
    const r = renderMarkdownNative('internal-links', { suggestions: [{ targetUrl: 'https://x.com/blog/three', anchorText: 'Guide three', targetTitle: 'The third guide' }] }, conv, { fileBody: post(related) });
    assert.equal(r.appendToRelatedList, true);
    assert.equal(r.value, '\n- [Guide three](/blog/three): The third guide\n');
  });
  test('expanded sections are plain Markdown above the FAQ; a table only where the collection already uses tables', () => {
    const r = renderMarkdownNative('expand-content', { sections: [{ heading: 'Pricing', body: 'Costs vary.', table: [{ plan: 'Pro', price: '$10' }] }] }, conv, { fileBody: post() });
    assert.equal(r.ok, true);
    assert.match(r.value, /## Pricing\n\nCosts vary\.\n\n\| plan \| price \|\n\| --- \| --- \|\n\| Pro \| \$10 \|/);
    const noTables = learnMarkdownConventions([post(faqBold + related)]);
    assert.equal(renderMarkdownNative('expand-content', { sections: [{ heading: 'P', body: 'x', table: [{ a: 1 }] }] }, noTables, { fileBody: post() }).reason, 'no-markdown-table-convention');
  });
});

describe('placeMarkdownMarker', () => {
  test('moves an EMPTY end-of-file marker above the section the site puts after it', () => {
    const file = `${post(related)}\n${marker('FAQ')}\n`;
    const { content, moved } = placeMarkdownMarker(file, 'FAQ', { placeBefore: '## Related guides' });
    assert.equal(moved, true);
    assert.ok(content.indexOf(marker('FAQ')) < content.indexOf('## Related guides'));
    assert.equal(content.split(marker('FAQ')).length, 2, 'exactly one marker pair remains');
  });
  test('appends inline to the last related item so new links continue that same list', () => {
    const { content } = placeMarkdownMarker(`${post(related)}\n${marker('INTERNALLINKS')}\n`, 'INTERNALLINKS', { appendToRelatedList: true });
    assert.match(content, /- \[Guide two\]\(\/blog\/two\): The second guide\.<!-- SEOAI:INTERNALLINKS:START --><!-- SEOAI:INTERNALLINKS:END -->/);
  });
  test('a marker that already holds content is never moved', () => {
    const file = `${post(related)}\n<!-- SEOAI:FAQ:START -->old<!-- SEOAI:FAQ:END -->\n`;
    assert.equal(placeMarkdownMarker(file, 'FAQ', { placeBefore: '## Related guides' }).moved, false);
  });
});

describe('planMarkdownTitleField', () => {
  const withTitleMarker = '---\ntitle: "Headline" # SEOAI:TITLE\nexcerpt: "x"\n---\nBody';
  test('a page with seoTitle: the change goes there, and the marker leaves the visible headline', () => {
    const r = planMarkdownTitleField('---\ntitle: "Headline" # SEOAI:TITLE\nseoTitle: "Short"\n---\nBody', []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.lineKeys, { title: 'seoTitle' });
    assert.match(r.content, /^title: "Headline"$/m);
  });
  test('the collection supports seoTitle → one is added, seeded with the current title', () => {
    const r = planMarkdownTitleField(withTitleMarker, [post()]);
    assert.equal(r.ok, true);
    assert.match(r.content, /^title: "Headline"\nseoTitle: "Headline"$/m);
  });
  test('no SEO-title field anywhere → the visible headline is not rewritten', () => {
    const r = planMarkdownTitleField(withTitleMarker, ['---\ntitle: "Other"\n---\n']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'title-is-visible-headline');
  });
  test('an explicitly configured title field always wins', () => {
    assert.deepEqual(planMarkdownTitleField(withTitleMarker, [], { title: 'title' }).lineKeys, { title: 'title' });
  });
});

// The 2026-11-23 incident (how-to-track-google-ai-overviews): the post already ended with its own FAQ and "Related guides", the
// EXPANDEDCONTENT slot sat at the very end, and three body sections were written under both.
describe('body sections never go below the FAQ or Related guides', () => {
  const ownFaq = '\n## Frequently asked questions\n\n### Is it free?\n\nYes.\n\n### Who is it for?\n\nTeams.\n';
  const page = (tail) => post(ownFaq + related + tail);
  const sections = [{ heading: 'How it differs', body: 'It differs.' }];

  test('the page\'s own closing section is found: whichever of FAQ and Related guides comes first', () => {
    assert.equal(ownClosingHeading(page('')).heading, '## Frequently asked questions');
    assert.equal(ownClosingHeading(post(related + ownFaq)).heading, '## Related guides');
    assert.equal(ownClosingHeading(post('')), null);
  });
  test('expand-content is placed above the page\'s OWN FAQ even when the site\'s usual heading is worded differently', () => {
    const conv = learnMarkdownConventions([post('\n## FAQ\n\n**Q one?** A.\n' + related), post('\n## FAQ\n\n**Q two?** A.\n' + related)]);
    const r = renderMarkdownNative('expand-content', { sections }, conv, { fileBody: page(marker('EXPANDEDCONTENT')) });
    assert.equal(r.placeBefore, '## Frequently asked questions', 'not the sibling convention "## FAQ", which this page does not have');
    const placed = placeMarkdownMarker(page(marker('EXPANDEDCONTENT')), 'EXPANDEDCONTENT', { placeBefore: r.placeBefore });
    assert.equal(placed.moved, true);
    assert.equal(expandedContentBelowClosingSection(placed.content, 'EXPANDEDCONTENT'), null);
    assert.ok(placed.content.indexOf('SEOAI:EXPANDEDCONTENT:START') < placed.content.indexOf('## Frequently asked questions'));
  });
  test('a slot left at the end of a page that has an FAQ is refused, with the reason in words', () => {
    const reason = expandedContentBelowClosingSection(page(marker('EXPANDEDCONTENT')), 'EXPANDEDCONTENT');
    assert.match(reason, /below this page's "Frequently asked questions" section/);
    assert.match(reason, /Move the slot above/);
  });
  test('a slot that already holds content is never moved, so it is refused rather than written under the FAQ', () => {
    const held = page('<!-- SEOAI:EXPANDEDCONTENT:START --><div>earlier section</div><!-- SEOAI:EXPANDEDCONTENT:END -->');
    assert.equal(placeMarkdownMarker(held, 'EXPANDEDCONTENT', { placeBefore: '## Frequently asked questions' }).moved, false);
    assert.ok(expandedContentBelowClosingSection(held, 'EXPANDEDCONTENT'));
  });
  test('fine when the slot is above the FAQ, when the page has no FAQ or related list, or has no such slot', () => {
    assert.equal(expandedContentBelowClosingSection(post(marker('EXPANDEDCONTENT') + ownFaq + related), 'EXPANDEDCONTENT'), null);
    assert.equal(expandedContentBelowClosingSection(post('\n## More\n\nText.\n' + marker('EXPANDEDCONTENT')), 'EXPANDEDCONTENT'), null);
    assert.equal(expandedContentBelowClosingSection(page(''), 'EXPANDEDCONTENT'), null);
  });
});
