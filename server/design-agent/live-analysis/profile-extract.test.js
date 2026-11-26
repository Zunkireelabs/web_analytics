import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { correctBodyTypography, bodySamples, correctHeadingTypography, headingSamplesByLevel, headingPageSamplesByContext, correctLinkTypography, correctPageTypeTextHierarchy, correctSpacing, backfillPageTypePatterns, articleBodyEvidence } from './profile-extract.js';

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

  test('an item heading is never left LARGER than the section heading above it', () => {
    // admizzeducation.com's real defect: no h3 anywhere, so `item` fell back to
    // the h2 pool — but the central pick for `item` landed on an oversized
    // display h2 (50px) while `section` landed on the real section heading
    // (42px). FAQ questions then shipped bigger than the section titles above
    // them. Both values are this site's own real evidence; the rule only asks
    // whether they agree with each other.
    const DISPLAY_H2 = 'text-[28px] sm:text-[36px] md:text-[50px] font-bold leading-[1.15]';
    const SECTION_H2 = 'text-3xl md:text-[42px] font-bold leading-tight';
    const { heading, corrected } = correctHeadingTypography(
      { section: SECTION_H2, item: DISPLAY_H2 }, new Map(),
    );
    assert.equal(heading.item, SECTION_H2, 'capped to the real section class, never an invented smaller one');
    assert.ok(corrected.includes('item:capped-to-section'));
  });

  test('the cap works on SEMANTIC class names too, using real measured pixels not the class string', () => {
    // chayceproperties.com's real shape: typography.heading uses semantic
    // classes ('home-h2') with no parseable size in the name at all — the
    // class-name-only reading (maxTextPx) sees null for both sides and can
    // never fire on this site. The real captured samples carry the actual
    // computed font-size regardless of naming convention, so this has to be
    // what the hierarchy check reads for it to mean anything here: a card
    // heading genuinely marked up as a literal <h3> but styled bigger (48px)
    // than the real section heading (34px) — same shape as Admizz's defect,
    // expressed in a naming convention maxTextPx can't parse at all.
    const pages = [page([
      h('h2', 'section-title', '34px'),
      h('h3', 'card-title-oversized', '48px'),
    ])];
    const { heading, corrected } = correctHeadingTypography({}, headingSamplesByLevel(pages));
    assert.equal(heading.item, 'section-title', 'capped to the real section class, which maxTextPx could never have picked either');
    assert.ok(corrected.includes('item:capped-to-section'));
  });

  test('an item heading SMALLER than the section heading is left exactly as it is', () => {
    const SECTION_H2 = 'text-3xl md:text-[42px] font-bold';
    const ITEM_H3 = 'text-xl md:text-2xl font-semibold';
    const { heading, corrected } = correctHeadingTypography(
      { section: SECTION_H2, item: ITEM_H3 }, new Map(),
    );
    assert.equal(heading.item, ITEM_H3);
    assert.deepEqual(corrected, []);
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

// The real defect this closes: the model's pageTypePatterns summary regularly
// returned a 'subheading' entry with only prose styleNotes and no classes (or
// an unobserved one), so marker-merge.js's groundedInlineHeadingClass — the
// only consumer of this field — could never find a real class to restyle a
// stripped inline-page heading with, and shipped a bare unstyled <h2> on
// every blog/article page an expand-content/faq section landed on.
describe('correctPageTypeTextHierarchy', () => {
  const REAL_SUBHEADING = 'text-xl font-semibold text-slate-800';
  const subheadingItem = (classes) => ({ role: 'subheading', tag: 'h2', classes, style: { fontSize: '20px', textTransform: 'none', letterSpacing: 'normal' } });
  const segPage = (pageType, items) => ({ pageType, sections: [{ role: 'content', textHierarchy: items }] });

  test('an unobserved (hallucinated) subheading class is replaced with the real one for that page type', () => {
    const patterns = {
      'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'text-4xl font-black', styleNotes: 'Bold section titles.' }] },
    };
    const segmentedPages = [
      segPage('blog-article', [subheadingItem(REAL_SUBHEADING)]),
      segPage('blog-article', [subheadingItem(REAL_SUBHEADING)]),
    ];
    const { pageTypePatterns, corrected } = correctPageTypeTextHierarchy(patterns, segmentedPages);
    assert.equal(pageTypePatterns['blog-article'].textHierarchy[0].classes, REAL_SUBHEADING);
    assert.deepEqual(corrected, ['blog-article']);
  });

  test('a genuinely observed subheading class is left alone', () => {
    const patterns = {
      'blog-article': { textHierarchy: [{ role: 'subheading', classes: REAL_SUBHEADING, styleNotes: 'ok' }] },
    };
    const segmentedPages = [segPage('blog-article', [subheadingItem(REAL_SUBHEADING)])];
    const { pageTypePatterns, corrected } = correctPageTypeTextHierarchy(patterns, segmentedPages);
    assert.equal(pageTypePatterns['blog-article'].textHierarchy[0].classes, REAL_SUBHEADING);
    assert.deepEqual(corrected, []);
  });

  test('no real evidence for that page type leaves classes null — never invented', () => {
    const patterns = {
      'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'text-4xl font-black', styleNotes: 'Bold section titles.' }] },
    };
    const { pageTypePatterns, corrected } = correctPageTypeTextHierarchy(patterns, []);
    assert.equal(pageTypePatterns['blog-article'].textHierarchy[0].classes, null);
    assert.deepEqual(corrected, []);
  });

  test('non-subheading roles (heading, body, link) are left untouched', () => {
    const patterns = {
      'blog-article': { textHierarchy: [{ role: 'heading', styleNotes: 'Direct.' }, { role: 'body', styleNotes: 'Dense.' }] },
    };
    const { pageTypePatterns, corrected } = correctPageTypeTextHierarchy(patterns, []);
    assert.deepEqual(pageTypePatterns['blog-article'].textHierarchy, patterns['blog-article'].textHierarchy);
    assert.deepEqual(corrected, []);
  });
});

describe('correctSpacing', () => {
  test('a fixed height stored as section spacing is dropped, not persisted as design knowledge', () => {
    // admizzeducation.com's profile held spacing.section: 'h-[70px]' — its
    // navbar height — which then composed into every projected component
    // wrapper, including the <dl> holding six Q&A pairs.
    assert.deepEqual(correctSpacing({ section: 'h-[70px]', itemGap: 'gap-2.5' }), { section: null, itemGap: 'gap-2.5' });
  });

  test('real spacing is untouched', () => {
    const real = { section: 'py-16 md:py-24', itemGap: 'space-y-4' };
    assert.deepEqual(correctSpacing(real), real);
  });

  test('a value carrying real spacing alongside a height is not a pure mistake and is kept', () => {
    assert.deepEqual(correctSpacing({ section: 'h-[70px] py-8' }), { section: 'h-[70px] py-8' });
  });

  test('missing/empty spacing stays empty', () => {
    assert.deepEqual(correctSpacing(null), {});
    assert.deepEqual(correctSpacing({}), {});
  });
});

describe('buildPromptPages keeps the extraction prompt under the model rate limit', () => {
  const sec = (n, classes = `c${n}`) => ({
    role: 'content', classes, alignment: 'left', width: 'full',
    textHierarchy: [{ role: 'h2', tag: 'h2', classes: `t-${classes}`, style: 'x' }], components: [], spacing: {},
  });
  const page = (url, pageType, sections) => ({ url, pageType, title: url, sections });

  test('drops sections repeated across pages (site chrome)', async () => {
    const { buildPromptPages } = await import('./profile-extract.js');
    const out = buildPromptPages([
      page('/a', 'home', [sec(0, 'nav'), sec(1)]),
      page('/b', 'blog', [sec(0, 'nav'), sec(2)]),
    ]);
    assert.equal(out.flatMap((p) => p.sections).filter((s) => s.classes === 'nav').length, 1);
  });

  test('every pageType appears before a second page of any type', async () => {
    const { buildPromptPages } = await import('./profile-extract.js');
    const out = buildPromptPages([
      page('/1', 'blog', [sec(1)]), page('/2', 'blog', [sec(2)]), page('/3', 'home', [sec(3)]),
    ], 700);
    assert.deepEqual(out.slice(0, 2).map((p) => p.pageType).sort(), ['blog', 'home']);
  });

  test('output never exceeds the character budget', async () => {
    const { buildPromptPages } = await import('./profile-extract.js');
    const pages = Array.from({ length: 40 }, (_, i) => page(`/p${i}`, `t${i % 5}`, Array.from({ length: 30 }, (_, j) => sec(i * 100 + j))));
    const out = buildPromptPages(pages, 6000);
    assert.ok(out.length > 0);
    assert.ok(JSON.stringify(out).length <= 6000 + 200 * out.length);
    const { PROMPT_PAGES_CHAR_BUDGET } = await import('./profile-extract.js');
    assert.ok(JSON.stringify(buildPromptPages(pages)).length <= PROMPT_PAGES_CHAR_BUDGET);
  });
});

describe('backfillPageTypePatterns', () => {
  const sec = (role, items = []) => ({ role, textHierarchy: items });
  const sub = (classes) => ({ role: 'subheading', classes, style: { fontSize: '24px', textTransform: 'none', letterSpacing: 'normal', fontWeight: '600' } });
  const pages = [
    { url: 'https://x.test/', pageType: 'homepage', sections: [sec('hero')] },
    { url: 'https://x.test/blog/a', pageType: 'blog-article', sections: [sec('nav'), sec('content', [sub('post-h2'), sub('post-h2'), sub('other-h2')]), sec('footer')] },
    { url: 'https://x.test/contact', pageType: 'other', sections: [sec('content', [sub('c-h2')])] },
  ];

  test('fills a captured page type the model left out, from observed classes only', () => {
    const { pageTypePatterns, filled } = backfillPageTypePatterns({ homepage: { sectionOrder: ['hero'], textHierarchy: [], notes: '' } }, pages);
    assert.deepEqual(filled, ['blog-article']);
    const article = pageTypePatterns['blog-article'];
    assert.equal(article.textHierarchy.find((t) => t.role === 'subheading').classes, 'post-h2');
    assert.deepEqual(article.sectionOrder, ['nav', 'content', 'footer']);
  });

  test('never replaces a pattern the model returned, and skips the catch-all "other"', () => {
    const model = { homepage: { sectionOrder: ['hero'], textHierarchy: [], notes: 'm' }, 'blog-article': { sectionOrder: ['x'], textHierarchy: [], notes: 'keep' } };
    const { pageTypePatterns, filled } = backfillPageTypePatterns(model, pages);
    assert.equal(pageTypePatterns['blog-article'].notes, 'keep');
    assert.equal(pageTypePatterns.other, undefined);
    assert.deepEqual(filled, []);
  });

  test('a role with no observed class is left out, not invented', () => {
    const only = [{ url: 'https://x.test/faq', pageType: 'faq', sections: [sec('content', [])] }];
    const { pageTypePatterns } = backfillPageTypePatterns({}, only);
    assert.deepEqual(pageTypePatterns.faq.textHierarchy, []);
  });
});

// mobilise.agency, 2026-11-19: the model returned { container: null, prose: null } and the platform rejected the whole profile, so design capture failed
// every time. The class names below are the real ones the capture observed (container 10x on about-us/services, cmp-wrap and hub-wrap on other pages).
describe('correctLayout', () => {
  const sec = (role, containerClasses) => ({ role, containerClasses });
  const pages = [
    { url: 'https://mobilise.agency/about-us/', sections: [sec('hero', 'container'), sec('content', 'container'), sec('content', 'container'), sec('footer', 'site-footer-premium')] },
    { url: 'https://mobilise.agency/services/', sections: [sec('hero', 'container'), sec('content', 'container cta-content'), sec('footer', 'site-footer-premium')] },
    { url: 'https://mobilise.agency/compare/', sections: [sec('content', 'cmp-wrap'), sec('content', 'cmp-wrap')] },
  ];
  test('an empty layout takes the wrapper observed most often inside content sections', async () => {
    const { correctLayout } = await import('./profile-extract.js');
    const r = correctLayout({ container: null, prose: null }, pages);
    assert.equal(r.layout.container, 'container');
    assert.deepEqual(r.corrected, { container: 'container', sections: 5 });
  });
  test('header/nav/footer chrome is never the content wrapper', async () => {
    const { correctLayout } = await import('./profile-extract.js');
    const chrome = [{ sections: [sec('footer', 'footer-inner'), sec('footer', 'footer-inner'), sec('footer', 'footer-inner')] }];
    assert.equal(correctLayout({}, chrome).corrected, null);
  });
  test('a wrapper seen on one section only is not the site\'s wrapper', async () => {
    const { correctLayout } = await import('./profile-extract.js');
    assert.equal(correctLayout({}, [{ sections: [sec('content', 'hub-wrap')] }]).corrected, null);
  });
  test('a class that is not a wrapper by name is not taken (stage-card x3)', async () => {
    const { correctLayout } = await import('./profile-extract.js');
    assert.equal(correctLayout({}, [{ sections: [sec('content', 'stage-card'), sec('content', 'stage-card'), sec('content', 'stage-card')] }]).corrected, null);
  });
  test('what the model returned is never overridden', async () => {
    const { correctLayout } = await import('./profile-extract.js');
    assert.deepEqual(correctLayout({ container: 'mx-auto max-w-6xl', prose: null }, pages), { layout: { container: 'mx-auto max-w-6xl', prose: null }, corrected: null });
    assert.equal(correctLayout({ container: null, prose: 'prose' }, pages).corrected, null);
  });
  test('no evidence at all: nothing is invented', async () => {
    const { correctLayout } = await import('./profile-extract.js');
    assert.equal(correctLayout(null, []).corrected, null);
    assert.deepEqual(correctLayout(undefined, undefined).layout, {});
  });
  test('the platform validation passes once the layout is filled', async () => {
    const { correctLayout } = await import('./profile-extract.js');
    const { validateDesignProfile, DESIGN_PROFILE_VERSION } = await import('../lib/design-profile.js');
    const base = { version: DESIGN_PROFILE_VERSION, typography: { body: 'hub-sub', heading: { item: 'sec-title' } } };
    assert.equal(validateDesignProfile({ ...base, layout: { container: null, prose: null } }).ok, false);
    assert.equal(validateDesignProfile({ ...base, layout: correctLayout({ container: null, prose: null }, pages).layout }).ok, true);
  });
});


// The article's own headings decide its subheading entry (zennly.io 2026-11: a navigation panel's class had become the article's "subheading" class).
describe('article body headings are the evidence for an article subheading', () => {
  const bh = (level, classes = '') => ({ level, classes, fontSize: level === 2 ? 28 : 20, fontWeight: '600', marginTop: 24 });
  const art = (bodyHeadings, sections = [], pageType = 'blog-article') => ({ url: 'https://x.test/blog/p', pageType, sections, bodyHeadings, bodyRegionFound: true });
  const MENU = { role: 'content', textHierarchy: [{ role: 'subheading', tag: 'h4', classes: 'v2-mm__aside-title', style: { fontSize: '18px' } }] };
  const sub = (patterns) => patterns['blog-article'].textHierarchy.find((e) => e.role === 'subheading');

  test('evidence counts every body heading, and how many of them carry a class', () => {
    const ev = articleBodyEvidence([art([bh(2), bh(2), bh(3, 'post-h3')])]).get('blog-article');
    assert.deepEqual([ev.observed, ev.classed, ev.items.map((i) => i.classes)], [3, 1, ['post-h3']]);
  });
  test('pages without body headings (older captures) and non-article page types give no body evidence', () => {
    assert.equal(articleBodyEvidence([{ pageType: 'blog-article', sections: [] }, art([bh(2)], [], 'service')]).size, 0);
  });
  test('BARE body headings are a positive finding: classes null, bare true, observed n, observedInBody true', () => {
    const { pageTypePatterns } = backfillPageTypePatterns({}, [art([bh(2), bh(2), bh(3)], [MENU])]);
    assert.deepEqual([sub(pageTypePatterns).classes, sub(pageTypePatterns).bare, sub(pageTypePatterns).observed, sub(pageTypePatterns).observedInBody], [null, true, 3, true]);
    assert.ok(!JSON.stringify(pageTypePatterns).includes('v2-mm__aside-title'), 'a chrome section can never reach the evidence');
  });
  test('a bare finding is never replaced by a class from elsewhere on the page (model summary or other blocks)', () => {
    const seg = [art([bh(2), bh(2), bh(3)], [MENU])];
    const out = correctPageTypeTextHierarchy({ 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'v2-mm__aside-title' }, { role: 'body', classes: 'x' }] } }, seg);
    assert.equal(sub(out.pageTypePatterns).classes, null); assert.equal(sub(out.pageTypePatterns).bare, true);
    assert.equal(out.pageTypePatterns['blog-article'].textHierarchy.find((e) => e.role === 'body').classes, 'x', 'other roles untouched');
    assert.deepEqual(out.corrected, ['blog-article']);
  });
  test('a model summary with NO subheading entry still gets the bare finding recorded', () => {
    const out = correctPageTypeTextHierarchy({ 'blog-article': { textHierarchy: [{ role: 'body', classes: 'x' }] } }, [art([bh(2), bh(3)])]);
    assert.equal(sub(out.pageTypePatterns).bare, true);
  });
  test('a client whose body headings DO carry a class keeps that class (central observed one), flagged as observed in the body', () => {
    const seg = [art([bh(2, 'post-h2'), bh(2, 'post-h2'), bh(3, 'post-h3')], [MENU])];
    const fromBackfill = sub(backfillPageTypePatterns({}, seg).pageTypePatterns);
    assert.deepEqual([fromBackfill.bare, fromBackfill.observedInBody, fromBackfill.observed], [false, true, 3]); assert.match(fromBackfill.classes, /post-h/);
    const fixed = sub(correctPageTypeTextHierarchy({ 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'text-4xl font-black' }] } }, seg).pageTypePatterns);
    assert.match(fixed.classes, /post-h/);
    const kept = correctPageTypeTextHierarchy({ 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'post-h2' }] } }, seg);
    assert.equal(sub(kept.pageTypePatterns).classes, 'post-h2'); assert.deepEqual(kept.corrected, [], 'an already-correct class is not reported as a correction');
  });
  test('mixed evidence: mostly-bare headings are bare, mostly-classed headings take the class', () => {
    assert.equal(sub(backfillPageTypePatterns({}, [art([bh(2), bh(2), bh(2), bh(3, 'x')])]).pageTypePatterns).bare, true);
    assert.equal(sub(backfillPageTypePatterns({}, [art([bh(2, 'a'), bh(2, 'a'), bh(2), bh(3, 'a')])]).pageTypePatterns).bare, false);
  });
  test('a page captured WITHOUT body headings behaves exactly as before (section-based evidence, chrome sections excluded by role)', () => {
    const old = [{ url: 'u', pageType: 'blog-article', sections: [{ role: 'nav', textHierarchy: [{ role: 'subheading', tag: 'h4', classes: 'v2-mm__aside-title', style: { fontSize: '18px' } }] }, { role: 'content', textHierarchy: [{ role: 'subheading', tag: 'h2', classes: 'post-h2', style: { fontSize: '28px' } }] }] }];
    const e = sub(backfillPageTypePatterns({}, old).pageTypePatterns);
    assert.equal(e.classes, 'post-h2'); assert.ok(!('observedInBody' in e));
  });
});
