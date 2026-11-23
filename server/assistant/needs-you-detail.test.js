import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionDetail, buildNeedsYou } from './needs-you.js';

test('decision card never renders "[object Object]" from the evidence array', () => {
  const u = {
    id: 1, subject: 'src/_includes/partials/footer.njk', category: 'shared-infrastructure', created_at: new Date().toISOString(),
    finding: {}, evidence: [{ detail: 'Included by 42 templates', source: 'repo scan' }, { detail: 'Contains the site nav', source: 'repo scan' }],
  };
  assert.equal(decisionDetail(u), 'Included by 42 templates; Contains the site nav');
  const [item] = buildNeedsYou({ unresolved: [u] });
  assert.doesNotMatch(item.detail, /object Object/);
});

test('summary/question win over evidence; non-string values are skipped, never stringified', () => {
  assert.equal(decisionDetail({ finding: { summary: ' Pick the blog template ' }, evidence: [{ detail: 'x' }] }), 'Pick the blog template');
  assert.equal(decisionDetail({ finding: { question: 'Which layout?' } }), 'Which layout?');
  assert.equal(decisionDetail({ finding: { summary: { nested: true } }, evidence: [{ detail: { also: 'object' } }, 'plain'] }), 'plain');
  assert.equal(decisionDetail({ evidence: { not: 'an array' } }), '');
  assert.equal(decisionDetail(null), '');
});

test('detail is capped at 200 characters', () => {
  assert.equal(decisionDetail({ evidence: [{ detail: 'a'.repeat(500) }] }).length, 200);
});
