import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCompliancePageBody, renderLandingPageBody, renderBlogOutlineBody,
  renderDirectAnswerBody, renderTranslationBody,
} from './newpage-render.js';
import { DESIGN_PROFILE_VERSION } from '../../design-agent/lib/design-profile.js';

describe('renderBlogOutlineBody featured image', () => {
  const siteWithBlogTarget = { url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md' } } } };
  const content = {
    title: 'Boiler Care Tips',
    sections: [{ heading: 'Bleeding radiators', body: 'Turn the valve.' }],
    featuredImage: { url: 'https://images.pexels.com/photos/12345/pexels-photo-12345.jpeg', alt: 'A radiator', photographer: 'Jane Doe' },
  };

  test('writes the LOCAL repo path, not the remote Pexels URL, in the display image field', () => {
    const out = renderBlogOutlineBody(content, siteWithBlogTarget);
    assert.match(out, /^image: "\/images\/blog\/boiler-care-tips\.jpeg"$/m);
    assert.doesNotMatch(out, /^image: ".*pexels\.com.*"$/m);
  });

  test('keeps the original Pexels URL in featuredImageSource for dedup', () => {
    const out = renderBlogOutlineBody(content, siteWithBlogTarget);
    assert.match(out, /^featuredImageSource: "https:\/\/images\.pexels\.com\/photos\/12345\/pexels-photo-12345\.jpeg"$/m);
  });

  test('respects a per-site imageDir override', () => {
    const site = { url_file_map: { newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md', imageDir: 'assets/blog-images' } } } };
    const out = renderBlogOutlineBody(content, site);
    assert.match(out, /^image: "\/assets\/blog-images\/boiler-care-tips\.jpeg"$/m);
  });

  test('no image field at all when no blog-outline target is configured (nowhere to put the file)', () => {
    const out = renderBlogOutlineBody(content, { url_file_map: {} });
    assert.doesNotMatch(out, /^image:/m);
    assert.doesNotMatch(out, /^featuredImageSource:/m);
  });

  test('no image field when the post has no featuredImage at all', () => {
    const out = renderBlogOutlineBody({ title: 'Boilers', sections: [] }, siteWithBlogTarget);
    assert.doesNotMatch(out, /^image:/m);
    assert.doesNotMatch(out, /^featuredImageSource:/m);
  });

  test('honours a sibling-derived field alias for the image key', () => {
    const out = renderBlogOutlineBody(content, siteWithBlogTarget, { fieldNames: { featuredImage: 'heroImage' } });
    assert.match(out, /^heroImage: "\/images\/blog\/boiler-care-tips\.jpeg"$/m);
  });
});

describe('renderCompliancePageBody', () => {
  const content = {
    headline: 'Privacy Policy',
    metaTitle: 'Privacy Policy — Zunkiree Labs',
    metaDescription: 'How we handle data.',
    disclaimer: 'This is a draft template, not legal advice.',
    sections: [
      { heading: 'Introduction', body: 'We respect your privacy.' },
      { heading: 'Data We Collect', body: 'Only what is listed here.' },
    ],
  };

  test('with no contentWrapper configured for the site, ships plain markdown unchanged (safe default for a new/unconfigured tenant)', () => {
    const body = renderCompliancePageBody(content, {}, { url_file_map: {} });
    assert.doesNotMatch(body, /<div/);
    assert.match(body, /# Privacy Policy/);
  });

  test('with no site argument at all, still ships plain markdown unchanged', () => {
    const body = renderCompliancePageBody(content, {});
    assert.doesNotMatch(body, /<div/);
    assert.match(body, /# Privacy Policy/);
  });

  test('with a site-specific contentWrapper componentTemplate configured, wraps the body in that real, per-tenant markup', () => {
    const site = {
      url_file_map: {
        siteRoot: {
          componentTemplates: {
            contentWrapper: { wrapper: '<div class="prose prose-lg prose-gray">\n{{BODY}}\n</div>' },
          },
        },
      },
    };
    const body = renderCompliancePageBody(content, {}, site);
    assert.match(body, /<div class="prose prose-lg prose-gray">/);
    assert.match(body, /<\/div>\n$/);
  });

  test('keeps a blank line right after the opening wrapper tag and right before the closing tag', () => {
    const site = {
      url_file_map: {
        siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div class="prose">\n{{BODY}}\n</div>' } } },
      },
    };
    const body = renderCompliancePageBody(content, {}, site);
    const openIdx = body.indexOf('<div class="prose">');
    const openLineEnd = body.indexOf('\n', openIdx);
    assert.equal(body.slice(openLineEnd, openLineEnd + 2), '\n\n');

    const closeIdx = body.indexOf('</div>');
    assert.equal(body.slice(closeIdx - 2, closeIdx), '\n\n');
  });

  test('a contentWrapper template missing the {{BODY}} placeholder is ignored, not applied broken', () => {
    const site = {
      url_file_map: {
        siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div class="prose"></div>' } } },
      },
    };
    const body = renderCompliancePageBody(content, {}, site);
    assert.doesNotMatch(body, /<div/);
  });

  test('still contains the real markdown headings/sections/disclaimer regardless of wrapper', () => {
    const body = renderCompliancePageBody(content, {});
    assert.match(body, /# Privacy Policy/);
    assert.match(body, /> \*\*This is a draft template, not legal advice\.\*\*/);
    assert.match(body, /## Introduction/);
    assert.match(body, /## Data We Collect/);
  });

  test('preserves an existing layout/permalink ahead of the body', () => {
    const body = renderCompliancePageBody(content, { layout: 'base.njk', permalink: '/privacy/' });
    assert.match(body, /layout: "base\.njk"/);
    assert.match(body, /permalink: "\/privacy\/"/);
  });
});

// The compliance trio was wrapped in the site's own prose markup; the other
// four net-new page types were not, so landing pages, blog posts,
// direct-answer pages and translations shipped bare <h1>/<h2>/<p> into real
// PRs — the same unstyled-body failure already confirmed live on
// zunkireelabs-web's /terms/, /privacy/ and /cookies/ before contentWrapper
// was captured for it.
describe('site prose wrapper across every net-new page type', () => {
  const siteWithWrapper = {
    url_file_map: {
      siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<article class="prose prose-lg">\n{{BODY}}\n</article>' } } },
    },
  };
  const bare = { url_file_map: {} };

  const cases = [
    ['renderLandingPageBody', renderLandingPageBody, { headline: 'Plumbers in Leeds', subheadline: 'Fast callouts.', sections: [{ heading: 'Why us', body: 'We show up.' }], cta: 'Book now' }, /# Plumbers in Leeds/],
    ['renderBlogOutlineBody', renderBlogOutlineBody, { title: 'Boiler care', sections: [{ heading: 'Bleeding radiators', body: 'Turn the valve.' }] }, /## Bleeding radiators/],
    ['renderDirectAnswerBody', renderDirectAnswerBody, { heading: 'How long does a boiler last?', directAnswer: 'Typically 10-15 years.' }, /# How long does a boiler last\?/],
    ['renderTranslationBody', renderTranslationBody, { translatedTitle: 'Servicios', translatedContent: '# Servicios\n\nOfrecemos fontanería.' }, /# Servicios/],
  ];

  for (const [name, render, content, bodyPattern] of cases) {
    test(`${name} wraps its body in the site's real prose markup when one is configured`, () => {
      const out = render(content, siteWithWrapper);
      assert.match(out, /<article class="prose prose-lg">/);
      assert.match(out, /<\/article>/);
      assert.match(out, bodyPattern, 'the real content survives the wrapping');
    });

    test(`${name} ships plain markdown when the site has no contentWrapper yet`, () => {
      const out = render(content, bare);
      assert.doesNotMatch(out, /<article/);
      assert.match(out, bodyPattern);
    });
  }

  test('front matter stays outside the wrapper — wrapping it would break the page', () => {
    const out = renderLandingPageBody({ headline: 'Leeds', metaTitle: 'Leeds' }, siteWithWrapper);
    const frontMatterEnd = out.indexOf('---', 3);
    assert.ok(out.indexOf('<article') > frontMatterEnd, 'wrapper opens after the closing front-matter fence');
  });
});

// The permalink is how a new page reaches a BUILD-TIME generated sitemap.
// zunkireelabs-web has no sitemap.xml in the repo at all — src/sitemap.njk
// (permalink: /sitemap.xml) iterates collections.all, so every page Eleventy
// builds is listed automatically. What decides whether it's listed at the
// RIGHT url is the page's own permalink.
describe('permalink front matter on net-new pages', () => {
  const site = { url_file_map: {} };

  test('every net-new renderer emits the resolved permalink', () => {
    assert.match(renderLandingPageBody({ headline: 'Leeds' }, site, { permalink: '/services/leeds/' }), /^permalink: "\/services\/leeds\/"$/m);
    assert.match(renderBlogOutlineBody({ title: 'Boilers' }, site, { permalink: '/blog/boilers/' }), /^permalink: "\/blog\/boilers\/"$/m);
    assert.match(renderDirectAnswerBody({ heading: 'How long?' }, site, { permalink: '/answers/how-long/' }), /^permalink: "\/answers\/how-long\/"$/m);
    assert.match(renderTranslationBody({ translatedTitle: 'Servicios' }, site, { permalink: '/es/servicios/' }), /^permalink: "\/es\/servicios\/"$/m);
  });

  test('no permalink resolved -> the key is omitted entirely, not written empty', () => {
    for (const [render, content] of [
      [renderLandingPageBody, { headline: 'Leeds' }],
      [renderBlogOutlineBody, { title: 'Boilers' }],
      [renderDirectAnswerBody, { heading: 'How long?' }],
      [renderTranslationBody, { translatedTitle: 'Servicios' }],
    ]) {
      assert.doesNotMatch(render(content, site), /permalink/, 'today\'s behavior is preserved exactly when urlPattern is unconfigured');
      assert.doesNotMatch(render(content, site, {}), /permalink/);
    }
  });

  test('an existing compliance page keeps its OWN permalink — overwriting must never move a live URL', () => {
    const body = renderCompliancePageBody(
      { headline: 'Privacy Policy' },
      { layout: 'base.njk', permalink: '/privacy/' },
      site,
      { permalink: '/pages/privacy-policy/' },
    );
    assert.match(body, /^permalink: "\/privacy\/"$/m);
    assert.doesNotMatch(body, /pages\/privacy-policy/);
  });

  test('a brand-new compliance page takes the resolved permalink', () => {
    const body = renderCompliancePageBody({ headline: 'Cookie Policy' }, {}, site, { permalink: '/cookies/' });
    assert.match(body, /^permalink: "\/cookies\/"$/m);
  });
});

describe('layout front matter on net-new pages', () => {
  const site = { url_file_map: {} };

  test('every net-new renderer emits the resolved layout', () => {
    assert.match(renderLandingPageBody({ headline: 'Leeds' }, site, { layout: 'base.njk' }), /^layout: "base\.njk"$/m);
    assert.match(renderBlogOutlineBody({ title: 'Boilers' }, site, { layout: 'blog-post.njk' }), /^layout: "blog-post\.njk"$/m);
    assert.match(renderDirectAnswerBody({ heading: 'How?' }, site, { layout: 'base.njk' }), /^layout: "base\.njk"$/m);
    assert.match(renderTranslationBody({ translatedTitle: 'Servicios' }, site, { layout: 'base.njk' }), /^layout: "base\.njk"$/m);
  });

  test('no layout resolved -> key omitted, page still builds exactly as today', () => {
    for (const [render, content] of [
      [renderLandingPageBody, { headline: 'Leeds' }],
      [renderBlogOutlineBody, { title: 'Boilers' }],
      [renderDirectAnswerBody, { heading: 'How?' }],
      [renderTranslationBody, { translatedTitle: 'Servicios' }],
    ]) {
      assert.doesNotMatch(render(content, site), /^layout:/m);
      assert.doesNotMatch(render(content, site, { permalink: '/x/' }), /^layout:/m);
    }
  });

  test('an existing compliance page keeps its OWN layout — overwriting must not restyle it', () => {
    const body = renderCompliancePageBody(
      { headline: 'Privacy Policy' },
      { layout: 'legal.njk', permalink: '/privacy/' },
      site,
      { layout: 'base.njk' },
    );
    assert.match(body, /^layout: "legal\.njk"$/m);
    assert.doesNotMatch(body, /base\.njk/);
  });

  test('a brand-new compliance page takes the resolved layout', () => {
    assert.match(renderCompliancePageBody({ headline: 'Cookies' }, {}, site, { layout: 'base.njk' }), /^layout: "base\.njk"$/m);
  });

  test('layout and permalink coexist, and the body still renders below them', () => {
    const out = renderLandingPageBody({ headline: 'Leeds', sections: [{ heading: 'Why', body: 'Fast.' }] }, site, { permalink: '/leeds/', layout: 'base.njk' });
    assert.match(out, /^layout: "base\.njk"$/m);
    assert.match(out, /^permalink: "\/leeds\/"$/m);
    assert.match(out, /## Why/);
  });
});

// Net-new pages emit markdown, so they cannot consume a component template —
// they were the last renderers still shipping presentation this platform
// invented rather than derived. These assert they now draw on the site's own
// design language, and that a site WITHOUT one is byte-for-byte unchanged.
describe('net-new pages consume the site design profile', () => {
  const PROFILE = {
    version: DESIGN_PROFILE_VERSION,
    styling: 'tailwind',
    typography: { heading: { item: 'text-lg font-medium', section: 'text-2xl' }, body: 'text-gray-600', link: 'text-blue-600' },
    layout: { container: 'max-w-3xl mx-auto', prose: 'prose' },
    components: {
      articleBody: { wrapper: 'prose prose-lg max-w-none' },
      button: { primary: 'inline-flex rounded-md bg-blue-600 px-4 py-2 text-white' },
      card: { wrapper: 'rounded-lg border border-gray-200 p-6' },
    },
  };
  const siteWithProfile = { url_file_map: { siteRoot: { designProfile: PROFILE } } };
  const siteWithNothing = { url_file_map: {} };

  const landing = {
    headline: 'Blood donation in Kathmandu',
    subheadline: 'Find a donor fast.',
    sections: [{ heading: 'Why us', body: 'Real body copy.' }],
    cta: 'Book a call',
  };

  test('a landing page CTA becomes a real button in the site\'s styling', () => {
    const out = renderLandingPageBody(landing, siteWithProfile);
    assert.match(out, /<a href="#" class="inline-flex rounded-md bg-blue-600 px-4 py-2 text-white">Book a call<\/a>/);
  });

  test('landing page sections use the site\'s card pattern', () => {
    const out = renderLandingPageBody(landing, siteWithProfile);
    assert.match(out, /<div class="rounded-lg border border-gray-200 p-6">/);
    assert.match(out, /## Why us/);
    assert.match(out, /Real body copy\./);
  });

  test('the page body is wrapped in the site\'s real article presentation', () => {
    for (const render of [renderLandingPageBody, renderBlogOutlineBody, renderDirectAnswerBody]) {
      const out = render({ ...landing, title: 'T', heading: 'H', sections: landing.sections }, siteWithProfile);
      assert.match(out, /prose prose-lg max-w-none/, `${render.name} did not use the site article wrapper`);
    }
  });

  test('translations get the same article presentation', () => {
    const out = renderTranslationBody({ translatedTitle: 'Titre', translatedContent: 'Bonjour.' }, siteWithProfile);
    assert.match(out, /prose prose-lg max-w-none/);
  });

  test('a configured contentWrapper still wins over the projection', () => {
    // An explicitly configured template is a stronger statement than a
    // derived profile, so it must not be overridden by one.
    const site = {
      url_file_map: {
        siteRoot: {
          designProfile: PROFILE,
          componentTemplates: { contentWrapper: { wrapper: '<article class="explicit">{{BODY}}</article>' } },
        },
      },
    };
    const out = renderLandingPageBody(landing, site);
    assert.match(out, /<article class="explicit">/);
    assert.doesNotMatch(out, /prose prose-lg max-w-none/);
  });

  test('REGRESSION: a site with no profile is completely unchanged', () => {
    const out = renderLandingPageBody(landing, siteWithNothing);
    assert.match(out, /\[Book a call\]\(#\)/, 'CTA stays a plain markdown link');
    assert.match(out, /## Why us\n\nReal body copy\./, 'sections stay plain markdown');
    assert.doesNotMatch(out, /<div class=/, 'no HTML introduced');
  });

  test('a profile with no button/card patterns falls back per-pattern, not wholesale', () => {
    // Sparse profiles are normal — a site may have an article wrapper but no
    // card convention. Each pattern degrades on its own.
    const sparse = { url_file_map: { siteRoot: { designProfile: { ...PROFILE, components: { articleBody: PROFILE.components.articleBody } } } } };
    const out = renderLandingPageBody(landing, sparse);
    assert.match(out, /prose prose-lg max-w-none/, 'still uses the article wrapper it does have');
    assert.match(out, /\[Book a call\]\(#\)/, 'no button pattern -> markdown link');
    assert.match(out, /## Why us/, 'no card pattern -> plain heading');
    assert.doesNotMatch(out, /rounded-lg border/);
  });
});

// Regression guard for a bug that shipped editorial instructions into published
// articles: renderBlogOutlineBody and renderDirectAnswerBody used to append
// "## FAQ topics to cover" and "## Suggested internal links" — notes ABOUT the
// article, aimed at whoever worked on it next — as real sections of the article
// itself. Survivable while a human reviewed every blog draft; not once
// blog-outline can open a PR unattended.
//
// Deliberately asserted HERE rather than left to the Quality Gate. That gate
// inspects the generator's `content` object, while the artifact actually
// committed is the markdown rendered by this module, so scaffolding introduced
// during rendering is invisible to it by construction.
describe('net-new content never publishes editorial scaffolding', () => {
  const withSuggestions = {
    title: 'Boiler care',
    heading: 'How do I bleed a radiator?',
    query: 'how to bleed a radiator',
    directAnswer: 'Turn the valve a quarter turn with a radiator key until water appears.',
    sections: [{ heading: 'Bleeding radiators', body: 'Turn the valve.' }],
    supportingSections: [{ heading: 'Tools you need', body: 'A radiator key and a cloth.' }],
    suggestedFaqTopics: ['How often should I bleed radiators?', 'What is a radiator key?'],
    suggestedInternalLinks: [{ anchorText: 'boiler servicing', targetUrl: 'https://x.com/services/boilers/' }],
  };

  for (const [name, render] of [
    ['renderBlogOutlineBody', renderBlogOutlineBody],
    ['renderDirectAnswerBody', renderDirectAnswerBody],
  ]) {
    test(`${name} omits the suggestion sections entirely`, () => {
      const out = render(withSuggestions, {});

      assert.doesNotMatch(out, /FAQ topics to cover/i, 'an instruction heading must never reach a reader');
      assert.doesNotMatch(out, /Suggested internal links/i);
      // The payloads themselves must not leak under some other heading either.
      assert.doesNotMatch(out, /How often should I bleed radiators\?/);
      assert.doesNotMatch(out, /boiler servicing/);
    });

    test(`${name} still renders the real article body`, () => {
      const out = render(withSuggestions, {});
      assert.match(out, /Turn the valve/, 'dropping scaffolding must not drop content');
      assert.match(out, /^---\n/, 'front matter is still emitted');
    });
  }

  test('suggestions are not required — absent fields render the same article', () => {
    const { suggestedFaqTopics, suggestedInternalLinks, ...bare } = withSuggestions;
    assert.equal(renderBlogOutlineBody(bare, {}), renderBlogOutlineBody(withSuggestions, {}));
  });
});

// A markdown table inside a freshly generated blog post must go through the
// same tenant-aware projectTable() call content-integrity-repair.js already
// uses to rebuild a broken table on an EXISTING page — see
// generators/lib/markdown-table-render.js. Before this, a new blog's table
// shipped as raw, unstyled `| --- |` markdown while a REPAIRED table on an
// old page got the site's real classes: two pipelines for the same problem.
describe('a markdown table inside generated content is projected through the tenant\'s table pattern', () => {
  const PROFILE = {
    version: DESIGN_PROFILE_VERSION,
    typography: { heading: { item: 'text-lg font-medium' }, body: 'text-gray-600' },
    layout: { prose: 'prose' },
    color: { border: 'border-gray-200' },
  };
  const siteWithProfile = { url_file_map: { siteRoot: { designProfile: PROFILE } } };

  const withTable = {
    title: 'Boiler brands compared',
    sections: [{
      heading: 'Comparison',
      body: 'Here is how they stack up:\n\n| Brand | Price |\n| --- | --- |\n| Worcester | £2000 |\n| Vaillant | £1800 |\n',
    }],
  };

  test('a real <table> using the site\'s own classes replaces the raw markdown table', () => {
    const out = renderBlogOutlineBody(withTable, siteWithProfile);
    assert.match(out, /<table class="w-full border-collapse">/);
    assert.match(out, /<th class="text-lg font-medium text-left">Brand<\/th>/);
    assert.match(out, /<td class="text-gray-600 text-left">Worcester<\/td>/);
    assert.doesNotMatch(out, /\| --- \| --- \|/, 'raw markdown table syntax must not reach the shipped page');
  });

  test('REGRESSION: a site with no design profile still gets a real (unstyled) table, not raw markdown', () => {
    const out = renderBlogOutlineBody(withTable, {});
    assert.match(out, /<table>/);
    assert.doesNotMatch(out, /\| --- \| --- \|/);
  });

  test('body content with no table is unaffected', () => {
    const noTable = { title: 'x', sections: [{ heading: 'H', body: 'Plain prose, no table here.' }] };
    const out = renderBlogOutlineBody(noTable, siteWithProfile);
    assert.match(out, /Plain prose, no table here\./);
  });
});
