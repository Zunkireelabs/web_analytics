import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRenderGate, describeDraftMarkup, formatInspection, INSPECT_SQL } from './inspect-draft-design.js';

const RG = {
  mode: 'enforce', blocked: true, reason: 'render-deviation', role: { role: 'inline-article', confidence: 'high', source: 'action-type' },
  referenceUrl: 'https://site.example/blog/x/',
  detail: { deviations: [{ kind: 'line-length', expected: 64, actual: 160, viewport: 'desktop' }] },
};

test('describeRenderGate: the mode, role, reference page, verdict and every measured deviation', () => {
  const text = describeRenderGate(RG).join('\n');
  assert.match(text, /mode:\s+enforce/);
  assert.match(text, /role:\s+inline-article \(confidence high/);
  assert.match(text, /reference:\s+https:\/\/site\.example\/blog\/x\//);
  assert.match(text, /BLOCKED/);
  assert.match(text, /line-length: the site renders 64, the draft 160 \(desktop\)/);
});

test('describeRenderGate: nothing recorded is said plainly, not as an error', () => {
  assert.match(describeRenderGate(null)[0], /none recorded/);
});

test('describeDraftMarkup: a bare body (no wrapper, no classes, plain <p>) is reported as exactly that', () => {
  const m = describeDraftMarkup('---\ntitle: x\n---\n<h2>Heading</h2><p>One.</p><p>Two.</p>');
  assert.equal(m.startsWithWrapper, false);
  assert.equal(m.paragraphs, 2);
  assert.equal(m.bareParagraphs, 2);
  assert.deepEqual(m.classTokens, []);
});

test('describeDraftMarkup: a wrapped, classed body reports its wrapper and class tokens', () => {
  const m = describeDraftMarkup('<div class="blog-content"><p class="t">One.</p><p class="t">Two.</p></div>');
  assert.equal(m.startsWithWrapper, true);
  assert.match(m.firstElement, /div class="blog-content"/);
  assert.deepEqual(m.classTokens[0], ['t', 2]);
  assert.equal(m.bareParagraphs, 0);
});

test('describeDraftMarkup: unconverted markdown headings, inline styles and layout hazards are surfaced', () => {
  const m = describeDraftMarkup('# Title\n\n<p style="font-size:40px">x</p><h1>Another</h1>');
  assert.equal(m.markdownHeadings, 1);
  assert.equal(m.inlineStyles, 1);
  assert.equal(m.h1, 1);
  assert.ok(m.hazards.length >= 2);
});

test('formatInspection: one readable report with the verdict, the markup facts and the draft identity', () => {
  const text = formatInspection({ id: 41, site_id: 7, action_type: 'direct-answer', status: 'abandoned', target_file_path: 'src/x.md', abandoned_reason: 'held', apply_error: null, render_gate: RG, rendered_body: '<h2>H</h2><p>t</p>' });
  assert.match(text, /draft 41\s+site 7\s+direct-answer/);
  assert.match(text, /NO wrapper element at the top/);
  assert.match(text, /every element is bare/);
  assert.doesNotMatch(text, /--- rendered_body ---/);
});

test('formatInspection: --html appends the full rendered body', () => {
  const text = formatInspection({ id: 1, render_gate: null, rendered_body: '<p>FULL BODY</p>' }, { showHtml: true });
  assert.match(text, /--- rendered_body ---\n<p>FULL BODY<\/p>\n--- end ---/);
});

test('the printed SQL is a single read-only SELECT', () => {
  assert.match(INSPECT_SQL, /^SELECT /);
  assert.doesNotMatch(INSPECT_SQL.replace(/--.*$/gm, ''), /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  assert.match(INSPECT_SQL, /render_gate/);
  assert.match(INSPECT_SQL, /rendered_body/);
});
