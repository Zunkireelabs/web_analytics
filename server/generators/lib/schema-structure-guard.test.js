import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSchemaIssues } from './schema-structure-guard.js';

test('valid Article jsonLd produces no issues', () => {
  const content = { jsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: 'Real headline' } };
  assert.deepEqual(findSchemaIssues(content), []);
});

test('valid FAQPage schemaJsonLd produces no issues', () => {
  const content = {
    schemaJsonLd: {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }],
    },
  };
  assert.deepEqual(findSchemaIssues(content), []);
});

test('flags missing @context', () => {
  const content = { jsonLd: { '@type': 'Article', headline: 'x' } };
  const issues = findSchemaIssues(content);
  assert.ok(issues.some((i) => i.patternId === 'schema-missing-context'));
});

test('flags missing @type', () => {
  const content = { jsonLd: { '@context': 'https://schema.org', headline: 'x' } };
  const issues = findSchemaIssues(content);
  assert.ok(issues.some((i) => i.patternId === 'schema-missing-type'));
});

test('flags missing required field for the given @type', () => {
  const content = { jsonLd: { '@context': 'https://schema.org', '@type': 'Article' } };
  const issues = findSchemaIssues(content);
  assert.ok(issues.some((i) => i.patternId === 'schema-missing-required-field' && i.path === 'jsonLd.headline'));
});

test('content with no jsonLd/schemaJsonLd field is not schema content — no issues', () => {
  assert.deepEqual(findSchemaIssues({ page: '/x', items: [] }), []);
});
