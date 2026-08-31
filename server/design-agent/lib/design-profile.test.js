import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDesignProfile, isProfileUsable, projectComponentTemplate,
  projectAllComponentTemplates, projectableActionTypes, stampDesignProfile,
  projectCta, projectCard, projectPageWrapper,
  DESIGN_PROFILE_VERSION,
} from './design-profile.js';
import { validatePlaceholders } from '../../implementers/lib/design-drift.js';

// A realistic profile in the shape the Design Agent derives from a real
// Tailwind site — every class here is the kind of thing actually observed in
// a repo, never invented.
const TAILWIND_PROFILE = {
  version: DESIGN_PROFILE_VERSION,
  styling: 'tailwind',
  framework: 'eleventy',
  typography: {
    heading: { section: 'text-2xl font-semibold text-gray-900', item: 'text-lg font-medium text-gray-900' },
    body: 'text-gray-600 leading-relaxed',
    link: 'text-blue-600 hover:text-blue-800',
  },
  color: { text: 'text-gray-900', muted: 'text-gray-500', accent: 'text-blue-600' },
  spacing: { section: 'py-12', itemGap: 'py-5' },
  layout: { container: 'max-w-3xl mx-auto', prose: 'prose prose-lg' },
  components: {
    accordion: { wrapper: 'divide-y divide-gray-200', item: '', trigger: 'w-full flex justify-between text-left', panel: 'mt-3' },
    card: { wrapper: 'rounded-lg border border-gray-200 p-6' },
    list: { wrapper: 'space-y-3', item: '', divider: 'divide-y divide-gray-100' },
    articleBody: { wrapper: 'prose prose-lg max-w-none' },
  },
  responsive: { breakpoints: ['sm', 'md', 'lg'] },
};

// A site with no JS accordion and no card pattern — the projections must
// still produce something in the site's own language, not a generic default.
const PLAIN_PROFILE = {
  version: DESIGN_PROFILE_VERSION,
  styling: 'plain-css',
  typography: { heading: { item: 'faq-question' }, body: 'body-text', link: 'link' },
  layout: { container: 'container' },
  components: {},
};

describe('validateDesignProfile', () => {
  test('accepts a complete profile', () => {
    assert.equal(validateDesignProfile(TAILWIND_PROFILE).ok, true);
  });

  test('accepts a sparse profile — missing optional patterns just project plainer', () => {
    assert.equal(validateDesignProfile(PLAIN_PROFILE).ok, true);
  });

  test('rejects a profile with no base body typography', () => {
    const { ok, errors } = validateDesignProfile({ ...PLAIN_PROFILE, typography: { heading: { item: 'x' } } });
    assert.equal(ok, false);
    assert.match(errors.join(' '), /typography\.body/);
  });

  test('rejects a profile with no item heading style', () => {
    const { ok, errors } = validateDesignProfile({ ...PLAIN_PROFILE, typography: { body: 'x', heading: {} } });
    assert.equal(ok, false);
    assert.match(errors.join(' '), /typography\.heading\.item/);
  });

  test('rejects a profile with no container or prose wrapper', () => {
    const { ok, errors } = validateDesignProfile({ ...PLAIN_PROFILE, layout: {} });
    assert.equal(ok, false);
    assert.match(errors.join(' '), /container\/prose/);
  });

  test('rejects an unknown version rather than guessing at its shape', () => {
    assert.equal(validateDesignProfile({ ...TAILWIND_PROFILE, version: 99 }).ok, false);
  });

  test('rejects null/garbage', () => {
    assert.equal(isProfileUsable(null), false);
    assert.equal(isProfileUsable('a profile'), false);
  });
});

// The contract that actually matters: a projection must satisfy the SAME
// placeholder rules the Design Agent's own derived templates are held to.
// validatePlaceholders is imported from design-drift rather than duplicated,
// so this can never drift from the authority on template validity.
describe('every projection satisfies design-drift\'s placeholder contract', () => {
  for (const actionType of projectableActionTypes()) {
    test(`${actionType} — from a full Tailwind profile`, () => {
      const template = projectComponentTemplate(TAILWIND_PROFILE, actionType);
      assert.ok(template, `${actionType} produced no template`);
      const check = validatePlaceholders(actionType, template);
      assert.equal(check.ok, true, `${actionType}: ${check.error}`);
    });

    test(`${actionType} — from a sparse plain-CSS profile`, () => {
      const template = projectComponentTemplate(PLAIN_PROFILE, actionType);
      assert.ok(template, `${actionType} produced no template`);
      const check = validatePlaceholders(actionType, template);
      assert.equal(check.ok, true, `${actionType}: ${check.error}`);
    });
  }
});

describe('projections use the site\'s real design language', () => {
  test('FAQ uses the site\'s accordion when it has one', () => {
    const { row, wrapper } = projectComponentTemplate(TAILWIND_PROFILE, 'faq');
    // Asserted as tokens, not as a contiguous substring: this profile's
    // list.divider ("divide-y divide-gray-100") and accordion.wrapper
    // ("divide-y divide-gray-200") both carry `divide-y`, and cx() now emits a
    // repeated token once. The accordion's divider styling still has to be
    // there — it just no longer arrives with a duplicate `divide-y` in front.
    for (const token of ['divide-y', 'divide-gray-200']) {
      assert.ok(wrapper.includes(token), `wrapper carries ${token}`);
    }
    assert.doesNotMatch(wrapper, /divide-y[\s\S]*divide-y/, 'no duplicated token');
    assert.match(row, /w-full flex justify-between text-left/);
    assert.match(row, /text-lg font-medium text-gray-900/, 'question uses the site item-heading style');
    assert.match(row, /text-gray-600 leading-relaxed/, 'answer uses the site body style');
  });

  test('FAQ degrades to a semantic definition list when the site has no accordion', () => {
    const { wrapper, row } = projectComponentTemplate(PLAIN_PROFILE, 'faq');
    assert.match(wrapper, /^<dl/);
    assert.match(row, /<dt class="faq-question">/);
    assert.match(row, /<dd class="body-text">/);
    assert.doesNotMatch(row, /x-show|@click/, 'no JS behaviour invented for a site that has none');
  });

  test('internal-links uses the site\'s list pattern and link colour', () => {
    const { wrapper, row } = projectComponentTemplate(TAILWIND_PROFILE, 'internal-links');
    assert.match(wrapper, /space-y-3/);
    assert.match(row, /text-blue-600 hover:text-blue-800/);
  });

  test('content-wrapper uses the site\'s real article body wrapper', () => {
    const { wrapper } = projectComponentTemplate(TAILWIND_PROFILE, 'content-wrapper');
    assert.match(wrapper, /prose prose-lg max-w-none/);
  });

  test('expand-content uses the section heading style when the site has one', () => {
    const { row } = projectComponentTemplate(TAILWIND_PROFILE, 'expand-content');
    assert.match(row, /text-2xl font-semibold/);
  });

  test('expand-content falls back to the item heading style when there is no section style', () => {
    const { row } = projectComponentTemplate(PLAIN_PROFILE, 'expand-content');
    assert.match(row, /faq-question/);
  });

  test('FAQ and qa-content share one visual language despite different structure', () => {
    // The whole point of a shared profile: two structures, one design.
    const faq = projectComponentTemplate(TAILWIND_PROFILE, 'faq');
    const qa = projectComponentTemplate(TAILWIND_PROFILE, 'qa-content');
    assert.notEqual(faq.row, qa.row, 'structures genuinely differ');
    for (const t of [faq.row, qa.row]) {
      assert.match(t, /text-lg font-medium text-gray-900/);
      assert.match(t, /text-gray-600 leading-relaxed/);
    }
  });
});

describe('projections never emit broken markup from a sparse profile', () => {
  test('no empty class attributes', () => {
    for (const actionType of projectableActionTypes()) {
      const t = projectComponentTemplate(PLAIN_PROFILE, actionType);
      const all = `${t.wrapper}\n${t.row || ''}`;
      assert.doesNotMatch(all, /class=""/, `${actionType} emitted an empty class attribute`);
      assert.doesNotMatch(all, /undefined|\[object Object\]/, `${actionType} leaked a JS value into markup`);
      assert.doesNotMatch(all, /class="\s/, `${actionType} emitted leading whitespace in a class list`);
    }
  });
});

describe('refusal', () => {
  test('an unusable profile projects nothing rather than a partial template', () => {
    assert.equal(projectComponentTemplate({ version: 1 }, 'faq'), null);
    assert.equal(projectComponentTemplate(null, 'faq'), null);
  });

  test('an unknown action type projects nothing', () => {
    assert.equal(projectComponentTemplate(TAILWIND_PROFILE, 'meta-title'), null);
  });

  test('projectAll skips what it cannot project instead of failing the batch', () => {
    const out = projectAllComponentTemplates(TAILWIND_PROFILE, ['faq', 'meta-title']);
    assert.deepEqual(Object.keys(out), ['faq']);
  });

  test('projectAll on an unusable profile returns nothing at all', () => {
    assert.deepEqual(projectAllComponentTemplates({ version: 1 }), {});
  });
});

describe('one analysis, many components', () => {
  test('a single profile projects every design-sensitive type', () => {
    const out = projectAllComponentTemplates(TAILWIND_PROFILE);
    assert.deepEqual(Object.keys(out).sort(), projectableActionTypes().sort());
    assert.equal(Object.keys(out).length, 5);
  });
});

describe('stampDesignProfile', () => {
  test('records provenance and pins the version', () => {
    const stamped = stampDesignProfile({ ...TAILWIND_PROFILE, version: undefined }, {
      derivedBy: 'design-agent', derivedRef: 42, at: new Date('2026-08-12T00:00:00Z'),
    });
    assert.equal(stamped.version, DESIGN_PROFILE_VERSION);
    assert.equal(stamped.derivedBy, 'design-agent');
    assert.equal(stamped.derivedRef, '42');
    assert.equal(stamped.derivedAt, '2026-08-12T00:00:00.000Z');
  });
});

// The net-new page renderers emit MARKDOWN, so they cannot consume a
// component template. These projections are how they get the same design
// language everything else uses — and the reason DEFAULT/plain markdown is
// now only reached by a site with no design knowledge at all.
describe('content-block projections for markdown renderers', () => {
  const WITH_PATTERNS = {
    ...TAILWIND_PROFILE,
    components: {
      ...TAILWIND_PROFILE.components,
      button: { primary: 'inline-flex rounded-md bg-blue-600 px-4 py-2 text-white', secondary: 'text-blue-600' },
      card: { wrapper: 'rounded-lg border border-gray-200 p-6', body: 'mt-2' },
    },
  };

  describe('projectCta', () => {
    test('renders a real button in the site\'s own styling', () => {
      const html = projectCta(WITH_PATTERNS, { label: 'Book a call' });
      assert.match(html, /class="inline-flex rounded-md bg-blue-600 px-4 py-2 text-white"/);
      assert.match(html, />Book a call</);
    });

    test('honours an explicit href', () => {
      assert.match(projectCta(WITH_PATTERNS, { label: 'Go', href: '/contact' }), /href="\/contact"/);
    });

    test('returns null when the site has no button convention — caller keeps its markdown link', () => {
      assert.equal(projectCta(TAILWIND_PROFILE, { label: 'Book a call' }), null);
      assert.equal(projectCta(null, { label: 'Book a call' }), null);
    });

    test('returns null with no label rather than an empty button', () => {
      assert.equal(projectCta(WITH_PATTERNS, { label: '' }), null);
    });
  });

  describe('projectCard', () => {
    test('wraps a section in the site\'s card pattern', () => {
      const md = projectCard(WITH_PATTERNS, { heading: 'Why us', body: 'Real **body** copy.' });
      assert.match(md, /<div class="rounded-lg border border-gray-200 p-6">/);
      assert.match(md, /## Why us/);
      assert.match(md, /Real \*\*body\*\* copy\./);
    });

    test('MARKDOWN SAFETY: blank lines separate the HTML from the markdown inside it', () => {
      // Without these, markdown-it swallows the inner content verbatim and
      // the section ships as unparsed source into a real PR.
      const md = projectCard(WITH_PATTERNS, { heading: 'H', body: 'B' });
      const lines = md.split('\n');
      assert.equal(lines[1], '', 'blank line must follow the opening tag');
      assert.equal(lines[lines.length - 2], '', 'blank line must precede the closing tag');
    });

    test('respects the requested heading level', () => {
      assert.match(projectCard(WITH_PATTERNS, { heading: 'H', body: 'B', headingLevel: 3 }), /### H/);
    });

    test('returns null when the site has no card convention', () => {
      // PLAIN_PROFILE has components: {} — TAILWIND_PROFILE does define a
      // card, so it is the wrong fixture for the no-pattern case.
      assert.equal(projectCard(PLAIN_PROFILE, { heading: 'H', body: 'B' }), null);
      assert.equal(projectCard(null, { heading: 'H', body: 'B' }), null);
    });
  });

  describe('projectPageWrapper', () => {
    test('is the SAME projection content-wrapper templates are built from', () => {
      // A page rendered through the markdown route and a compliance page
      // rendered through the component template must land in identical markup.
      assert.equal(projectPageWrapper(TAILWIND_PROFILE), projectComponentTemplate(TAILWIND_PROFILE, 'content-wrapper').wrapper);
    });

    test('null for an unusable profile', () => {
      assert.equal(projectPageWrapper({ version: 1 }), null);
      assert.equal(projectPageWrapper(null), null);
    });
  });
});

// Regression: the four projection defects found live on zunkireelabs.com
// (2026-08-31), each of which shipped to real customer pages under a
// `verifiedBy: design-agent` stamp.
describe('projection defects found live on a real customer site', () => {
  test('no class token is ever emitted twice in one attribute', () => {
    // layout.prose and spacing.section describing the same real convention is
    // normal; it produced `class="container-custom py-12 md:py-20 py-12 md:py-20"`.
    const overlapping = {
      ...TAILWIND_PROFILE,
      spacing: { section: 'py-12 md:py-20', itemGap: 'gap-3' },
      layout: { container: 'container-custom', prose: 'py-12 md:py-20' },
      components: { ...TAILWIND_PROFILE.components, articleBody: { wrapper: 'py-12 md:py-20' }, list: { wrapper: '', item: 'flex items-start gap-3', divider: '' } },
    };
    for (const actionType of projectableActionTypes()) {
      const projected = projectComponentTemplate(overlapping, actionType);
      for (const markup of [projected.wrapper, projected.row].filter(Boolean)) {
        for (const [, attrValue] of markup.matchAll(/\sclass="([^"]*)"/g)) {
          const tokens = attrValue.trim().split(/\s+/).filter(Boolean);
          assert.deepEqual(
            tokens, [...new Set(tokens)],
            `${actionType} emitted a duplicate class token: "${attrValue}"`,
          );
        }
      }
    }
  });

  test('expand-content is placed inside the site container like every sibling', () => {
    // Without it, the block was the only thing on the page rendering full
    // bleed while everything around it was gutter-aligned.
    const { wrapper } = projectComponentTemplate(TAILWIND_PROFILE, 'expand-content');
    assert.ok(
      wrapper.includes(TAILWIND_PROFILE.layout.container),
      'expand-content wrapper must carry layout.container',
    );
  });

  test('an internal link is styled as a link, never link classes merged with body classes', () => {
    const { row } = projectComponentTemplate(TAILWIND_PROFILE, 'internal-links');
    const cls = /<a href="\{\{URL\}\}" class="([^"]*)"/.exec(row)[1];
    assert.equal(cls, TAILWIND_PROFILE.typography.link);
    assert.ok(
      !cls.includes(TAILWIND_PROFILE.typography.body),
      'merging both put two competing text-* colours on one anchor',
    );
  });

  test('body typography is the fallback for a site with no link convention', () => {
    const noLink = { ...TAILWIND_PROFILE, typography: { ...TAILWIND_PROFILE.typography, link: null } };
    const { row } = projectComponentTemplate(noLink, 'internal-links');
    assert.match(row, /<a href="\{\{URL\}\}" class="text-gray-600 leading-relaxed"/);
  });
});
