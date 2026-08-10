#!/usr/bin/env node
// Phase 2 of the Rendering Validation Gate — the client-repo-build half.
// Installed VERBATIM into a client repo by this app's
// server/scripts/install-rendering-workflow.js (source of truth: this exact
// file, in the zunkiree-analytics app) and run by that repo's own
// "rendering-validation" GitHub Actions workflow (workflow.yml, same
// directory) after the site's real build — so this checks the REAL rendered
// HTML output, not the Markdown source. Deliberately zero-dependency (only
// Node builtins) since it has to run standalone in an arbitrary client
// repo's CI with no access back to this app's node_modules.
//
// Complements, not replaces, Phase 1 (implementers/lib/rendering-gate.js's
// checkRenderCapability, which runs in THIS app before a PR is even opened,
// checking config only). This script is the only one of the two that can
// catch a broken layout, a markdown plugin misconfigured for a subset of
// shortcodes, or any other build-specific failure Phase 1's config check
// can't see — because it's the only one that runs the real build.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// Conservative on purpose — same "strong signal only" discipline as
// generators/lib/content-scaffolding-guard.js's SCAFFOLDING_PATTERNS, so a
// legitimately hyphenated sentence or a real inline code sample never trips
// this. Checked against VISIBLE text only (script/style/pre/code/comments
// stripped first, see stripNonVisible) — a code sample showing someone
// Markdown syntax on purpose is not a bug.
const PATTERNS = [
  { id: 'markdown-heading', regex: /^\s{0,3}#{1,6}\s+\S/m },
  { id: 'markdown-bold', regex: /\*\*[^\s*][^*]*\*\*/ },
  { id: 'markdown-list-item', regex: /^\s{0,3}[-*]\s+\S/m },
  { id: 'unresolved-mustache', regex: /\{\{[^{}]{1,120}\}\}/ },
  { id: 'unresolved-template-tag', regex: /\{%[^{}]{1,120}%\}/ },
];

function stripNonVisible(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<pre[\s\S]*?<\/pre>/gi, '')
    .replace(/<code[\s\S]*?<\/code>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ');
}

// Pure, testable core — the CLI block below is the only part that touches
// the filesystem/process, so server/implementers/lib/rendering-validation-
// templates/check-rendered-output.test.js (in the analytics app) can test
// this directly against sample HTML strings.
export function findRenderingIssues(html) {
  const visibleText = stripTags(stripNonVisible(html));
  const issues = [];
  for (const { id, regex } of PATTERNS) {
    const match = visibleText.match(regex);
    if (match) issues.push({ id, snippet: match[0].slice(0, 120) });
  }
  return issues;
}

function walkHtmlFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkHtmlFiles(full, files);
    else if (extname(entry) === '.html') files.push(full);
  }
  return files;
}

// CLI entry point — only runs when this file is executed directly (`node
// check-rendered-output.mjs <outputDir>`), never when imported for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outputDir = process.argv[2] || '_site';

  let htmlFiles;
  try {
    htmlFiles = walkHtmlFiles(outputDir);
  } catch (err) {
    console.error(`Could not read build output directory "${outputDir}": ${err.message}`);
    process.exit(1);
  }

  if (!htmlFiles.length) {
    console.error(`No .html files found under "${outputDir}" — is the build command/output directory configured correctly?`);
    process.exit(1);
  }

  const allIssues = [];
  for (const file of htmlFiles) {
    const raw = readFileSync(file, 'utf8');
    for (const issue of findRenderingIssues(raw)) allIssues.push({ file, ...issue });
  }

  if (allIssues.length) {
    console.error(`Found ${allIssues.length} rendering issue(s) — raw Markdown or unresolved template syntax visible in built HTML:\n`);
    for (const { file, id, snippet } of allIssues) {
      console.error(`  [${id}] ${file}\n    "${snippet}"`);
    }
    process.exit(1);
  }

  console.log(`OK — checked ${htmlFiles.length} built HTML file(s) under "${outputDir}", no raw Markdown/unresolved template syntax found.`);
}
