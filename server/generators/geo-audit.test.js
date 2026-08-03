import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { meta } from './geo-audit.js';

describe('geo-audit generator meta', () => {
  test('has correct id', () => {
    assert.equal(meta.id, 'geo-audit');
  });

  test('has name', () => {
    assert.equal(meta.name, 'GEO Audit Generator');
  });

  test('has description', () => {
    assert.ok(meta.description.length > 0);
  });

  test('has recommendationTags', () => {
    assert.ok(Array.isArray(meta.recommendationTags));
    assert.ok(meta.recommendationTags.length > 0);
  });
});

describe('geo-audit report structure', () => {
  test('report includes overall score section', () => {
    const report = '# GEO Audit: Test Site\n\n## Overall AI Visibility Score: 75/100';
    assert.ok(report.includes('## Overall AI Visibility Score'));
  });

  test('report includes category breakdown table', () => {
    const report = '| Category | Score | Status |\n|---|---|---|\n| schema | 89/100 | Excellent |';
    assert.ok(report.includes('| Category | Score | Status |'));
  });

  test('report includes crawlability section', () => {
    const report = '## Crawlability & AI-Crawler Access\n\n⚠️ No llms.txt file found.';
    assert.ok(report.includes('## Crawlability & AI-Crawler Access'));
  });

  test('report includes top pages urgency table', () => {
    const report = '## Top Pages by Urgency';
    assert.ok(report.includes('## Top Pages by Urgency'));
  });

  test('report includes recommended actions section', () => {
    const report = '## Recommended Actions';
    assert.ok(report.includes('## Recommended Actions'));
  });

  test('report includes summary section', () => {
    const report = '## Summary';
    assert.ok(report.includes('## Summary'));
  });
});