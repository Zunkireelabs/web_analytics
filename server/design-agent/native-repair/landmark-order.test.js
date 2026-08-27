import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkLandmarkOrderPreserved, detectLandmarkLabels } from './landmark-order.js';

// Real shape, trimmed down: the actual zunkireelabs-web location-service.njk
// incident this module exists to catch — a "HERO SECTION" banner comment
// near the top of the file, with a footer-ish CTA further down.
const REAL_TEMPLATE = `---
layout: base.njk
---
<script type="application/ld+json">{}</script>

{# =====================================================
   HERO SECTION
   ===================================================== #}
<section class="hero">{{ location.name }}</section>

{# =====================================================
   CTA SECTION
   ===================================================== #}
<section class="cta">Contact us</section>
`;

describe('detectLandmarkLabels', () => {
  test('finds banner-comment sections in top-to-bottom order', () => {
    // "hero" also appears between the two banner comments because the Hero
    // section's own markup carries class="hero" — a real, separately
    // detected landmark (the Tailwind-class convention), not a duplicate.
    assert.deepEqual(detectLandmarkLabels(REAL_TEMPLATE), ['hero section', 'hero', 'cta section']);
  });

  test('returns an empty list for a file with no recognizable landmarks', () => {
    assert.deepEqual(detectLandmarkLabels('<div>{{ x }}</div>'), []);
  });

  test('also recognizes plain semantic HTML tags, not just banner comments', () => {
    assert.deepEqual(detectLandmarkLabels('<header>x</header><main>y</main><footer>z</footer>'), ['header', 'main', 'footer']);
  });
});

describe('checkLandmarkOrderPreserved', () => {
  test('ok: nothing to check when the original file has no landmarks', () => {
    const result = checkLandmarkOrderPreserved('<div>plain</div>', '<div>plain</div><section class="hero">new</section>');
    assert.equal(result.ok, true);
  });

  test('ok: new content correctly appended AFTER all existing sections', () => {
    const after = `${REAL_TEMPLATE}
{# =====================================================
   EXPANDED CONTENT (AI-managed)
   ===================================================== #}
{% if x.expandedContent %}{{ x.expandedContent | safe }}{% endif %}
`;
    const result = checkLandmarkOrderPreserved(REAL_TEMPLATE, after);
    assert.equal(result.ok, true);
  });

  // The exact real-world failure this module exists to catch: new sections
  // spliced in BETWEEN the file's opening script tag and its existing Hero
  // section — i.e. above the Hero, on live rendered pages.
  test('fails: new content inserted BEFORE the existing Hero section', () => {
    const after = REAL_TEMPLATE.replace(
      '{# =====================================================\n   HERO SECTION',
      `{# =====================================================
   SERVICES GRID
   ===================================================== #}
<section class="services">...</section>

{# =====================================================
   HERO SECTION`,
    );
    const result = checkLandmarkOrderPreserved(REAL_TEMPLATE, after);
    assert.equal(result.ok, false);
    assert.match(result.reason, /hero section/i);
    assert.match(result.reason, /before/i);
  });

  test('fails: an existing section was removed by the edit', () => {
    const after = REAL_TEMPLATE.replace(/{# =+\s*\n\s*CTA SECTION\s*\n\s*=+ #}\n<section class="cta">Contact us<\/section>\n/, '');
    const result = checkLandmarkOrderPreserved(REAL_TEMPLATE, after);
    assert.equal(result.ok, false);
    assert.match(result.reason, /cta section/i);
  });

  test('fails: existing sections were reordered (Hero moved after CTA)', () => {
    const heroBlock = '{# =====================================================\n   HERO SECTION\n   ===================================================== #}\n<section class="hero">{{ location.name }}</section>';
    const ctaBlock = '{# =====================================================\n   CTA SECTION\n   ===================================================== #}\n<section class="cta">Contact us</section>';
    const after = REAL_TEMPLATE
      .replace(heroBlock, '__HERO_PLACEHOLDER__')
      .replace(ctaBlock, heroBlock)
      .replace('__HERO_PLACEHOLDER__', ctaBlock);
    const result = checkLandmarkOrderPreserved(REAL_TEMPLATE, after);
    assert.equal(result.ok, false);
  });

  test('ok: unrelated whitespace/content changes within an existing section do not trip the check', () => {
    const after = REAL_TEMPLATE.replace('{{ location.name }}', '{{ location.name }} — updated copy');
    const result = checkLandmarkOrderPreserved(REAL_TEMPLATE, after);
    assert.equal(result.ok, true);
  });
});
