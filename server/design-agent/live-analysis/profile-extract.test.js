import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { correctBodyTypography, bodySamples, correctHeadingTypography, headingSamplesByLevel, headingPageSamplesByContext, correctLinkTypography } from './profile-extract.js';

// The real classes and computed styles captured from zunkireelabs.com on
// 2026-08-31. The eyebrow is the site's most consistent body-role paragraph —
// every section has one above its heading — which is exactly why the model
// picked it and why no prompt wording could have prevented that.
const EYEBROW = 'text-xs uppercase tracking-widest text-zunkiree-600 font-medium mb-6';
const REAL_BODY = 'text-lg text-gray-600 leading-relaxed';

const eyebrowSample = (text = 'AI-First Technology Company') => ({
  role: 'body',
  classes: EYEBROW,
  text,
  style: { fontSize: '12px', color: 'rgb(235, 22, 0)', textTransform: 'uppercase', letterSpacing: '2.4px' },
});

const bodySample = (classes = REAL_BODY) => ({
  role: 'body',
  classes,
  text: 'Zunkiree Labs builds AI infrastructure for teams that need it to actually work in production.',
  style: { fontSize: '18px', color: 'rgb(75, 85, 99)', textTransform: 'none', letterSpacing: 'normal' },
});

describe('correctBodyTypography', () => {
  test('replaces an eyebrow pick with the real body class', () => {
    const samples = [eyebrowSample(), eyebrowSample('Our Platform'), eyebrowSample('Why Us'), bodySample()];
    const { body, corrected } = correctBodyTypography(EYEBROW, samples);
    assert.equal(body, REAL_BODY);
    assert.equal(corrected, true);
  });

  test('leaves a correct pick alone', () => {
    const { body, corrected } = correctBodyTypography(REAL_BODY, [eyebrowSample(), bodySample()]);
    assert.equal(body, REAL_BODY);
    assert.equal(corrected, false);
  });

  test('picks the most frequent body-like class, not merely the first', () => {
    const samples = [
      eyebrowSample(),
      bodySample('text-sm text-gray-500'),
      bodySample(REAL_BODY), bodySample(REAL_BODY), bodySample(REAL_BODY),
    ];
    assert.equal(correctBodyTypography(EYEBROW, samples).body, REAL_BODY);
  });

  test('returns null when every sample is a label, making the profile unusable', () => {
    // Deliberate: validateDesignProfile requires typography.body, so a null
    // here means every generator falls back to its plain default. Shipping no
    // styling is recoverable; shipping all prose as tiny uppercase text is not.
    const { body, corrected } = correctBodyTypography(EYEBROW, [eyebrowSample(), eyebrowSample('Our Platform')]);
    assert.equal(body, null);
    assert.equal(corrected, true);
  });

  test('a small-but-not-uppercase caption is still rejected as body copy', () => {
    const caption = {
      role: 'body',
      classes: 'text-xs text-gray-400',
      text: 'Photo by someone on Pexels',
      style: { fontSize: '12px', textTransform: 'none', letterSpacing: 'normal' },
    };
    assert.equal(correctBodyTypography('text-xs text-gray-400', [caption]).body, null);
  });

  test('wide letter-spacing alone marks a label', () => {
    const tracked = {
      role: 'body',
      classes: 'tracking-widest text-gray-700',
      text: 'A fairly long line of text that is nonetheless a styled label treatment',
      style: { fontSize: '16px', textTransform: 'none', letterSpacing: '3px' },
    };
    assert.equal(correctBodyTypography('tracking-widest text-gray-700', [tracked, bodySample()]).body, REAL_BODY);
  });

  test('no samples at all leaves the model\'s pick untouched', () => {
    // Nothing to check against is not evidence the pick is wrong.
    const { body, corrected } = correctBodyTypography(REAL_BODY, []);
    assert.equal(body, REAL_BODY);
    assert.equal(corrected, false);
  });
});

describe('bodySamples excludes site chrome', () => {
  const page = (role, classes) => ({
    sections: [{ role, textHierarchy: [{ role: 'body', classes, style: { fontSize: '14px' } }] }],
  });

  test('footer, header and nav paragraphs are not body-copy evidence', () => {
    const pages = [page('footer', 'a'), page('header', 'b'), page('nav', 'c'), page('content', 'd')];
    assert.deepEqual(bodySamples(pages).map((s) => s.classes), ['d']);
  });

  test('a footer class cannot win on frequency alone', () => {
    // The real regression: `text-navy-200 ... max-w-sm` is light text sized for
    // a dark navy footer, appears on every page, and beat the true body class
    // 6-to-3 before chrome was excluded. It would have rendered generated
    // paragraphs near-invisible on a white content background.
    const footer = (n) => Array.from({ length: n }, () => page('footer', 'text-navy-200 text-small leading-relaxed'));
    const content = (n) => Array.from({ length: n }, () => page('content', 'text-gray-600 leading-relaxed'));
    const { body } = correctBodyTypography(EYEBROW, bodySamples([...footer(6), ...content(3)]));
    assert.equal(body, 'text-gray-600 leading-relaxed');
  });
});

describe('correctBodyTypography picks the central class, not the longest or the first', () => {
  const at = (size, classes) => ({ role: 'body', classes, style: { fontSize: size, textTransform: 'none', letterSpacing: 'normal' } });

  test('recurring tokens beat per-section emphasis modifiers', () => {
    // Every one of these is unique as a whole string, so whole-string counting
    // has nothing to go on and falls back to insertion order. `text-gray-600`
    // and `leading-relaxed` recur across all of them; the size and width
    // modifiers do not.
    const samples = [
      at('24px', 'text-xl md:text-2xl text-gray-900 leading-relaxed font-normal'),
      at('20px', 'text-lg md:text-xl text-gray-600 leading-relaxed max-w-2xl'),
      at('18px', 'text-lg text-gray-600 mb-8 max-w-2xl mx-auto'),
      at('16px', 'text-gray-600 leading-relaxed'),
    ];
    assert.equal(correctBodyTypography(EYEBROW, samples).body, 'text-gray-600 leading-relaxed');
  });

  test('whitespace variants of one class are treated as the same class', () => {
    const samples = [at('16px', 'text-gray-600  leading-relaxed'), at('16px', ' text-gray-600 leading-relaxed ')];
    assert.equal(correctBodyTypography(EYEBROW, samples).body, 'text-gray-600 leading-relaxed');
  });

  test('a 24px pull-quote does not win just by being listed first', () => {
    const samples = [
      at('24px', 'text-xl md:text-2xl text-gray-900 leading-relaxed font-normal italic'),
      at('16px', 'text-gray-600 leading-relaxed'),
      at('16px', 'pt-4 text-gray-600 leading-relaxed'),
    ];
    assert.equal(correctBodyTypography(EYEBROW, samples).body, 'text-gray-600 leading-relaxed');
  });
});

describe('correctHeadingTypography', () => {
  const h = (tag, classes, fontSize = '36px') => ({
    role: 'heading', tag, classes, style: { fontSize, textTransform: 'none', letterSpacing: 'normal' },
  });
  const page = (items, role = 'content') => ({ sections: [{ role, textHierarchy: items }] });

  test('a section heading comes from h2, not from the page h1', () => {
    // The real defect: this site's typography.heading.section was its homepage
    // <h1> class, so every heading in an injected expand-content block rendered
    // at hero size, visibly larger than the real section headings around it.
    const H1 = 'text-4xl md:text-5xl lg:text-6xl font-normal text-gray-900 leading-tight mb-8';
    const H2 = 'text-3xl md:text-4xl lg:text-5xl font-normal text-gray-900';
    const pages = [page([h('h1', H1, '60px'), h('h2', H2)]), page([h('h2', H2)]), page([h('h2', H2)])];
    const { heading, corrected } = correctHeadingTypography({ section: H1, item: null }, headingSamplesByLevel(pages));
    assert.equal(heading.section, H2);
    assert.ok(corrected.includes('section'));
  });

  test('an item heading prefers h3, falling back to h2 when the site has none', () => {
    const H2 = 'text-3xl font-normal text-gray-900';
    const H3 = 'text-xl md:text-2xl font-normal text-gray-900 mb-3';
    const withH3 = headingSamplesByLevel([page([h('h2', H2), h('h3', H3, '24px')])]);
    assert.equal(correctHeadingTypography({}, withH3).heading.item, H3);

    const noH3 = headingSamplesByLevel([page([h('h2', H2)])]);
    assert.equal(correctHeadingTypography({}, noH3).heading.item, H2);
  });

  test('an uppercase eyebrow marked up as an h2 is not a heading candidate', () => {
    const EYEBROW_H2 = 'text-sm uppercase tracking-widest text-gray-500 font-medium mb-4';
    const H2 = 'text-3xl md:text-4xl font-normal text-gray-900';
    const pages = [page([
      { role: 'heading', tag: 'h2', classes: EYEBROW_H2, style: { fontSize: '14px', textTransform: 'uppercase', letterSpacing: '2px' } },
      h('h2', H2),
    ])];
    assert.equal(correctHeadingTypography({}, headingSamplesByLevel(pages)).heading.section, H2);
  });

  test('chrome headings are excluded, and no evidence leaves the pick alone', () => {
    const pages = [page([h('h2', 'footer-heading')], 'footer')];
    const { heading, corrected } = correctHeadingTypography({ section: 'kept', item: 'kept-too' }, headingSamplesByLevel(pages));
    assert.deepEqual(heading, { section: 'kept', item: 'kept-too', page: {} });
    assert.deepEqual(corrected, []);
  });

  // The real gap this whole feature closes: a site can legitimately run a
  // bigger <h1> in its hero than on an interior page (this platform's first
  // client does — 60px on landing-style templates, 48px elsewhere), and that
  // is a real per-template decision, not drift. headingPageSamplesByContext
  // splits real <h1> samples by whether their OWN section is a hero so both
  // values get recorded, on any site, from that site's own real evidence.
  test('hero and standard h1 samples are recorded separately, from real section.role evidence', () => {
    const heroH1 = 'text-6xl font-black';
    const standardH1 = 'text-4xl font-bold';
    const pages = [
      { sections: [{ role: 'hero', textHierarchy: [h('h1', heroH1, '60px')] }] },
      { sections: [{ role: 'content', textHierarchy: [h('h1', standardH1, '48px')] }] },
      { sections: [{ role: 'content', textHierarchy: [h('h1', standardH1, '48px')] }] },
    ];
    const byContext = headingPageSamplesByContext(pages);
    assert.equal(byContext.hero.length, 1);
    assert.equal(byContext.hero[0].classes, heroH1);
    assert.equal(byContext.standard.length, 2);
    assert.ok(byContext.standard.every((s) => s.classes === standardH1));

    const { heading, corrected } = correctHeadingTypography({}, new Map(), byContext);
    assert.equal(heading.page.hero, heroH1);
    assert.equal(heading.page.standard, standardH1);
    assert.deepEqual(corrected.sort(), ['page.hero', 'page.standard']);
  });

  test('an h1 with no hero-section evidence leaves heading.page.hero alone (no evidence is not a defect)', () => {
    const pages = [page([h('h1', 'text-4xl font-bold', '48px')])];
    const { heading, corrected } = correctHeadingTypography({}, new Map(), headingPageSamplesByContext(pages));
    assert.equal(heading.page.hero, undefined);
    assert.equal(heading.page.standard, 'text-4xl font-bold');
    assert.deepEqual(corrected, ['page.standard']);
  });
});

describe('correctLinkTypography', () => {
  const BUTTON = 'inline-flex items-center justify-center px-7 py-3.5 bg-zunkiree-600 text-white font-medium';
  const TEXT_LINK = 'text-zunkiree-600 hover:underline';

  test('a link class identical to the primary button is a CTA, not a link style', () => {
    // internal-links rendered every related link as a full-width filled button.
    const { link, corrected } = correctLinkTypography(BUTTON, { button: { primary: BUTTON, secondary: TEXT_LINK } });
    assert.equal(link, TEXT_LINK);
    assert.equal(corrected, true);
  });

  test('null when the site has no secondary treatment — never an invented one', () => {
    const { link } = correctLinkTypography(BUTTON, { button: { primary: BUTTON, secondary: null } });
    assert.equal(link, null);
  });

  test('a genuine inline link style is left alone', () => {
    const { link, corrected } = correctLinkTypography(TEXT_LINK, { button: { primary: BUTTON, secondary: TEXT_LINK } });
    assert.equal(link, TEXT_LINK);
    assert.equal(corrected, false);
  });
});
