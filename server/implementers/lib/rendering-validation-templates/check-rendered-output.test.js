import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRenderingIssues } from './check-rendered-output.mjs';

test('clean, fully-rendered HTML produces no issues', () => {
  const html = '<html><body><h1>Welcome</h1><p>This is a normal sentence — nothing odd here.</p></body></html>';
  assert.deepEqual(findRenderingIssues(html), []);
});

test('flags a raw Markdown heading that leaked into visible text', () => {
  const html = '<html><body><p>## Overview</p><p>Real content follows.</p></body></html>';
  const issues = findRenderingIssues(html);
  assert.ok(issues.some((i) => i.id === 'markdown-heading'));
});

test('flags raw Markdown bold syntax', () => {
  const html = '<html><body><p>This is **very** important.</p></body></html>';
  const issues = findRenderingIssues(html);
  assert.ok(issues.some((i) => i.id === 'markdown-bold'));
});

test('flags a raw Markdown list item', () => {
  const html = '<html><body><p>- First point\n- Second point</p></body></html>';
  const issues = findRenderingIssues(html);
  assert.ok(issues.some((i) => i.id === 'markdown-list-item'));
});

test('flags an unresolved mustache template variable', () => {
  const html = '<html><body><p>Welcome to {{city}}!</p></body></html>';
  const issues = findRenderingIssues(html);
  assert.ok(issues.some((i) => i.id === 'unresolved-mustache'));
});

test('flags an unresolved Nunjucks/Liquid template tag', () => {
  const html = '<html><body><p>{% for item in items %}stuck loop{% endfor %}</p></body></html>';
  const issues = findRenderingIssues(html);
  assert.ok(issues.some((i) => i.id === 'unresolved-template-tag'));
});

test('does not flag Markdown-looking syntax inside a <pre>/<code> block (a real code sample)', () => {
  const html = '<html><body><pre><code>## Not a real heading\n**not bold**\n{{ not.a.leak }}</code></pre></body></html>';
  assert.deepEqual(findRenderingIssues(html), []);
});

test('does not flag Markdown-looking syntax inside a <script> or <style> block', () => {
  const html = '<html><head><style>/* ## fake heading in a comment */</style>'
    + '<script>const s = "**bold**"; // {{not real}}</script></head><body><p>Fine.</p></body></html>';
  assert.deepEqual(findRenderingIssues(html), []);
});

test('does not flag an ordinary hyphenated sentence as a list item', () => {
  const html = '<html><body><p>State-of-the-art, budget-friendly software.</p></body></html>';
  assert.deepEqual(findRenderingIssues(html), []);
});

test('does not flag a real HTML comment left in the markup', () => {
  const html = '<html><body><!-- ## TODO: revisit this section --><p>Real content.</p></body></html>';
  assert.deepEqual(findRenderingIssues(html), []);
});
