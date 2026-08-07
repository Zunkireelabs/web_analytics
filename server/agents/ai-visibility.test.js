import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webMcpFinding, recommendationsFor } from './ai-visibility.js';
import { scorePageCategories } from './lib/visibility-score.js';

describe('webMcpFinding', () => {
  test('null when a manifest is present — nothing to inform about', () => {
    assert.equal(webMcpFinding({ webMcpReadiness: { hasManifest: true }, analyzedCount: 10 }), null);
  });

  test('null when webMcpReadiness itself is null (no real origin could be resolved)', () => {
    assert.equal(webMcpFinding({ webMcpReadiness: null, analyzedCount: 10 }), null);
  });

  test('a real, low-priority, informational-only finding when no manifest is found', () => {
    const finding = webMcpFinding({ webMcpReadiness: { hasManifest: false }, analyzedCount: 7 });
    assert.notEqual(finding, null);
    assert.equal(finding.id, 'ai-visibility:site:webmcp');
    assert.equal(finding.priority, 'low');
    // Never a draftable action — a real manifest requires knowing this
    // site's actual invocable actions, which nothing here can honestly derive.
    assert.equal(finding.recommendedAction, null);
    assert.equal(finding.evidence.analyzedPages, 7);
    assert.equal(finding.evidence.hasManifest, false);
  });
});

describe('schema markup recommendation', () => {
  // Real regression: zunkireelabs-web's /locations/:city/:service pages
  // render live Service + LocalBusiness JSON-LD (see
  // src/_includes/layouts/location-service.njk) — exactly 2 schema types,
  // both genuine entity types. The old c.schema<=50-only rule flagged these
  // "Add schema markup" anyway since it only counted types, never checked
  // whether they were substantive. Confirmed 2026-08-07.
  const twoRealEntityTypes = { schemaTypes: ['Service', 'LocalBusiness'], h1Count: 1, h2Count: 1, listCount: 1, tableCount: 0, hasFaqSchema: false, hasFaqHeading: false, questionHeadingCount: 0 };

  test('does not recommend adding schema when 2 schema types are already real entity types', () => {
    const categories = scorePageCategories(twoRealEntityTypes);
    assert.equal(categories.schema, 50); // raw type count is still thin...
    assert.equal(categories.entities, 100); // ...but entity coverage is complete
    const recs = recommendationsFor(categories);
    assert.equal(recs.some((r) => r.generatorId === 'schema' && r.label.startsWith('Add schema markup')), false);
  });

  test('still recommends adding schema when 2 schema types are thin/structural, not entity types', () => {
    const thinStructuralTypes = { ...twoRealEntityTypes, schemaTypes: ['WebPage', 'BreadcrumbList'] };
    const categories = scorePageCategories(thinStructuralTypes);
    assert.equal(categories.schema, 50);
    assert.equal(categories.entities, 0);
    const recs = recommendationsFor(categories);
    assert.equal(recs.some((r) => r.generatorId === 'schema' && r.label.startsWith('Add schema markup')), true);
  });
});
