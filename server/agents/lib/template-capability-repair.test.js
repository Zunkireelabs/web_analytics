import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAiManagedSlots, findSlotForGenerator, adaptSlotBlock, classifyCapabilityGap,
  buildTemplatePatch, deriveAdapterConfig, GENERATOR_VALUE_KEYS,
} from './template-capability-repair.js';

// Fixtures are verbatim excerpts (trimmed) of the real templates on
// zunkireelabs-web this module was built against — src/_includes/layouts/
// location.njk and location-service.njk — not invented shapes.
const LOCATION_NJK = `
{% if location.faqs and location.faqs.length > 0 %}
<section>...faqs...</section>
{% endif %}

{# =====================================================
   EXPANDED CONTENT (AI-managed — written by the Action Center)
   Only rendered when location.expandedContent is present; never
   fabricated here or by the generator that writes it — see
   server/generators/expand-content.js. Already a fully rendered HTML
   block (wrapper + rows), not raw text.
   ===================================================== #}
{% if location.expandedContent %}
{{ location.expandedContent | safe }}
{% endif %}

{# =====================================================
   Q&A CONTENT (AI-managed — written by the Action Center)
   Only rendered when location.qaContentHtml is present — see
   server/generators/qa-content.js.
   ===================================================== #}
{% if location.qaContentHtml %}
{{ location.qaContentHtml | safe }}
{% endif %}

<section class="cta">...</section>
`;

const LOCATION_SERVICE_NJK = `
<script type="application/ld+json">{"@type": "Service"}</script>

{# =====================================================
   REVIEW / AGGREGATE RATING SCHEMA (AI-managed — written by the Action Center)
   Only rendered when serviceContent.reviewSchema is present; never fabricated
   here or by the generator that writes it — see server/generators/schema.js.
   ===================================================== #}
{% if serviceContent.reviewSchema %}
<script type="application/ld+json">
{{ serviceContent.reviewSchema | dump | safe }}
</script>
{% endif %}

<section class="hero">...</section>
<section class="cta">...</section>
`;

describe('parseAiManagedSlots', () => {
  test('finds every slot in location.njk with correct generator hints', () => {
    const slots = parseAiManagedSlots(LOCATION_NJK);
    assert.equal(slots.length, 2);
    assert.equal(slots[0].fieldExpr, 'location.expandedContent');
    assert.equal(slots[0].generatorId, 'expand-content');
    assert.equal(slots[0].isAiManaged, true);
    assert.equal(slots[1].fieldExpr, 'location.qaContentHtml');
    assert.equal(slots[1].generatorId, 'qa-content');
  });

  test('finds the dump|safe schema slot in location-service.njk', () => {
    const slots = parseAiManagedSlots(LOCATION_SERVICE_NJK);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].fieldExpr, 'serviceContent.reviewSchema');
    assert.equal(slots[0].generatorId, 'schema');
  });

  test('a mismatched if/output guard is not treated as a slot', () => {
    const bad = `{% if location.foo %}\n{{ location.bar | safe }}\n{% endif %}`;
    assert.deepEqual(parseAiManagedSlots(bad), []);
  });

  test('finds nothing in a template with no AI-managed convention at all', () => {
    assert.deepEqual(parseAiManagedSlots('<section>plain</section>'), []);
  });
});

describe('classifyCapabilityGap', () => {
  test('plumbing-gap: slot already exists in this template, just unconfigured', () => {
    const result = classifyCapabilityGap({
      templateSource: LOCATION_NJK, generatorId: 'expand-content', hasAdapterConfig: false,
    });
    assert.equal(result.classification, 'plumbing-gap');
    assert.equal(result.ownSlot.fieldExpr, 'location.expandedContent');
  });

  test('already-wired: slot exists and config is already there — nothing to do', () => {
    const result = classifyCapabilityGap({
      templateSource: LOCATION_NJK, generatorId: 'expand-content', hasAdapterConfig: true,
    });
    assert.equal(result.classification, 'already-wired');
  });

  test('safe-capability-gap: no slot here, but a sibling route already solved this exact generator', () => {
    const result = classifyCapabilityGap({
      templateSource: LOCATION_SERVICE_NJK,
      siblingTemplateSources: [{ label: 'location.njk', source: LOCATION_NJK }],
      generatorId: 'expand-content',
      hasAdapterConfig: false,
    });
    assert.equal(result.classification, 'safe-capability-gap');
    assert.equal(result.siblingSlot.fieldExpr, 'location.expandedContent');
    // location-service.njk DOES have one AI-managed slot of its own
    // (reviewSchema) — the anchor must point at IT, not be null, so the
    // derived block lands grouped with the existing AI-managed section.
    assert.notEqual(result.anchorEnd, null);
  });

  test('architectural-gap: no slot here and no sibling has ever solved this generator', () => {
    const result = classifyCapabilityGap({
      templateSource: LOCATION_SERVICE_NJK,
      siblingTemplateSources: [{ label: 'location.njk', source: LOCATION_NJK }],
      generatorId: 'internal-links',
      hasAdapterConfig: false,
    });
    assert.equal(result.classification, 'architectural-gap');
  });

  test('architectural-gap when a template has no AI-managed slot of its own AND no sibling is given', () => {
    const result = classifyCapabilityGap({
      templateSource: '<section>plain, no AI-managed convention at all</section>',
      generatorId: 'expand-content',
      hasAdapterConfig: false,
    });
    assert.equal(result.classification, 'architectural-gap');
  });
});

describe('adaptSlotBlock / buildTemplatePatch', () => {
  test('adaptSlotBlock ports the sibling block onto a new base variable, changing nothing else', () => {
    const slots = parseAiManagedSlots(LOCATION_NJK);
    const expandSlot = findSlotForGenerator(slots, 'expand-content');
    const adapted = adaptSlotBlock(expandSlot, 'serviceContent');
    assert.match(adapted, /serviceContent\.expandedContent/);
    assert.doesNotMatch(adapted, /\blocation\.expandedContent\b/);
    // the surrounding comment/markup is preserved verbatim
    assert.match(adapted, /AI-managed — written by the Action Center/);
    assert.match(adapted, /server\/generators\/expand-content\.js/);
  });

  test('buildTemplatePatch inserts the adapted block after the local anchor slot', () => {
    const gap = classifyCapabilityGap({
      templateSource: LOCATION_SERVICE_NJK,
      siblingTemplateSources: [{ label: 'location.njk', source: LOCATION_NJK }],
      generatorId: 'expand-content',
      hasAdapterConfig: false,
    });
    const patched = buildTemplatePatch(LOCATION_SERVICE_NJK, gap, 'serviceContent');
    assert.match(patched, /serviceContent\.expandedContent/);
    // Original reviewSchema slot is untouched, and the new block comes after it.
    const reviewIdx = patched.indexOf('serviceContent.reviewSchema');
    const expandIdx = patched.indexOf('serviceContent.expandedContent');
    assert.ok(reviewIdx > -1 && expandIdx > reviewIdx);
    // Nothing else in the template changed — the hero/cta sections survive verbatim.
    assert.match(patched, /<section class="hero">\.\.\.<\/section>/);
    assert.match(patched, /<section class="cta">\.\.\.<\/section>/);
  });

  test('buildTemplatePatch refuses to guess a position when there is no local anchor', () => {
    const gap = { classification: 'safe-capability-gap', siblingSlot: parseAiManagedSlots(LOCATION_NJK)[0], anchorEnd: null };
    assert.throws(() => buildTemplatePatch('<section>no anchor here</section>', gap, 'serviceContent'));
  });

  test('buildTemplatePatch refuses a non-safe-capability-gap result', () => {
    assert.throws(() => buildTemplatePatch(LOCATION_SERVICE_NJK, { classification: 'architectural-gap' }, 'serviceContent'));
  });
});

describe('deriveAdapterConfig', () => {
  test('clones dataFile/idField/format/nestedField from an existing sibling adapter, retargets fields', () => {
    const existingMetaTitleAdapter = {
      id: 'data-array-content', format: 'js-export-array', idField: 'id',
      dataFile: 'src/_data/locations.js', nestedField: 'services',
      fields: { title: 'title', metaDescription: 'description' },
    };
    const derived = deriveAdapterConfig(existingMetaTitleAdapter, {
      generatorId: 'expand-content', valueKey: GENERATOR_VALUE_KEYS['expand-content'], fieldName: 'expandedContent',
    });
    assert.deepEqual(derived, {
      id: 'data-array-content', format: 'js-export-array', dataFile: 'src/_data/locations.js',
      idField: 'id', nestedField: 'services', fields: { expandedContent: 'expandedContent' },
    });
  });

  test('throws rather than inventing dataFile/idField when no sibling adapter exists', () => {
    assert.throws(() => deriveAdapterConfig(null, { generatorId: 'expand-content', valueKey: 'expandedContent', fieldName: 'expandedContent' }));
  });
});

describe('GENERATOR_VALUE_KEYS', () => {
  test('matches marker-merge.js buildMergeValues real return keys', () => {
    assert.equal(GENERATOR_VALUE_KEYS['expand-content'], 'expandedContent');
    assert.equal(GENERATOR_VALUE_KEYS['qa-content'], 'qaContent');
    assert.equal(GENERATOR_VALUE_KEYS['internal-links'], 'links');
  });
});
