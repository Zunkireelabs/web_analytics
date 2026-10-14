#!/usr/bin/env node
// Captures a component template from a REAL, working example of that component
// in a tenant's own repo, and stores it as that site's componentTemplates entry.
//
// WHY THIS EXISTS
//
// projectComponentTemplate composes a template out of a design profile's flat
// vocabulary (typography, spacing, one accordion class set). That is the right
// fallback, but it can only rebuild what the profile has words for. When a site
// has a genuinely rich component — zunkireelabs.com's FAQ is an Alpine
// accordion with an expand-all toggle, a rotating +/- icon and enter/leave
// transitions — the projection degrades it to a semantic <dl>, because the
// profile has no vocabulary for any of that.
//
// The result is a site with two different FAQ designs: the good one on the five
// pages a human built, and a definition list everywhere the agent reached.
// A configured componentTemplates entry already takes precedence over a
// projection everywhere in the pipeline, so the fix is to capture the real one
// once, rather than to teach the projector about accordions it cannot see.
//
// The capture is mechanical: take the component's real markup, replace the
// example content with the template's placeholders, and keep every class,
// attribute and wrapper exactly as the site wrote it. Nothing is invented and
// nothing is restyled.
//
//   node server/scripts/capture-component-template.js --site 1 \
//     --repo <path> --file src/pages/products/search.njk --marker FAQ --type faq
//   ... --commit
//
// Pass --page <url> to capture/verify against a SPECIFIC live page instead of
// the site's homepage, and store it in the page-scoped tier
// (pageComponentTemplates[key]) instead of overwriting the site-level
// componentTemplates[key] entry — for a site with no shared design system
// (page-scoped inline CSS, a different <style> block per page — see
// design-drift.js's PAGE-SCOPED COMPONENT TEMPLATES section), the homepage's
// classes are not evidence of what any other page actually uses.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db.js';
import { validatePlaceholders, verifyTemplateAgainstLiveSite, sitePageUrl, pageTemplateFileKey } from '../implementers/lib/design-drift.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const siteId = Number(arg('site'));
const repo = arg('repo');
const file = arg('file');
const marker = arg('marker');
const type = arg('type');
const key = arg('key') || type;
// A specific live URL to capture/verify this template against, instead of
// the site's homepage — for a site with no shared design system (see
// design-drift.js's PAGE-SCOPED COMPONENT TEMPLATES section), the homepage
// is not a valid stand-in for every other page's own real design. Given,
// this stores into the page-specific/page-type tier
// (pageComponentTemplates[key]) rather than overwriting the single
// site-level componentTemplates[key] entry, which stays reserved for a
// genuinely shared, sitewide template.
const page = arg('page');
const commit = process.argv.includes('--commit');

if (!siteId || !repo || !file || !marker || !type) {
  console.error('Usage: capture-component-template.js --site <id> --repo <path> --file <src/...> --marker FAQ --type faq [--key faq] [--page <url>] [--commit]');
  process.exit(1);
}

const text = await readFile(path.join(repo, file), 'utf8');
const region = new RegExp(`<!--\\s*SEOAI:${marker}:START\\s*-->([\\s\\S]*?)<!--\\s*SEOAI:${marker}:END\\s*-->`).exec(text);
if (!region) {
  console.error(`No SEOAI:${marker} region in ${file}.`);
  process.exit(1);
}
const html = region[1];

// SHAPES this script can capture. Each names the container whose direct
// children repeat, how one row starts, and which sub-elements hold the content.
// Anchoring on the real container rather than on a class name keeps the capture
// honest about what it actually found.
const SHAPES = {
  accordion: {
    container: /(<div class="divide-y[^"]*">)([\s\S]*?)(<\/div>\s*<\/div>\s*<\/div>\s*<\/section>)/,
    row: /(^|\n)(\s*)<div class="py-5">[\s\S]*?(?=\n\s*<div class="py-5">|$)/g,
    slots: [
      [/(<span class="text-lg[^"]*">)([\s\S]*?)(<\/span>)/, 'QUESTION'],
      [/(<p class="pt-4[^"]*">)([\s\S]*?)(<\/p>)/, 'ANSWER'],
    ],
    minRows: 2,
  },
  // A plain stack of headed sections — how this site appends generated prose to
  // a page (an h3 at text-xl/2xl, not a page-level h2 at text-3xl+). Capturing
  // it is what stops injected sections from being visibly larger than the
  // headings the site sets by hand.
  section: {
    container: /(<div class="max-w-screen-2xl[^"]*">)([\s\S]*?)(<\/div>\s*<\/section>)/,
    row: /(^|\n)(\s*)<div class="mb-8 last:mb-0">[\s\S]*?<\/div>(?=\n|$)/g,
    slots: [
      [/(<h3 class="text-xl[^"]*">)([\s\S]*?)(<\/h3>)/, 'HEADING'],
      [/(<p class="text-gray-600[^"]*">)([\s\S]*?)(<\/p>)/, 'BODY'],
    ],
    minRows: 1,
  },
  // The site's real Q&A card shape (products/search.njk's SEOAI:QACONTENT
  // region) — native <details> disclosure cards, distinct from the
  // 'accordion' shape's Alpine.js divide-y pattern used by SEOAI:FAQ. Added
  // because qa-content's captured template had gone stale (verify-component-
  // templates.js: "captured markup shape no longer found"), and neither
  // existing shape's regex matches a <details> list, so every qa-content
  // injection since had been falling back to the generic unstyled
  // '<div class="qa-content">{{ROWS}}</div>' wrapper (marker-merge.js) — the
  // literal "blog Q&A not using the FAQ design" defect reported live.
  details: {
    container: /(<div class="container-custom py-12 md:py-20">)([\s\S]*)(<\/div>)\s*$/,
    row: /<details class="[^"]*">[\s\S]*?<\/details>/g,
    slots: [
      [/(<h3 class="[^"]*">)([\s\S]*?)(<\/h3>)/, 'QUESTION'],
      [/(<div class="text-gray-600 leading-relaxed">)([\s\S]*?)(<\/div>)/, 'ANSWER'],
    ],
    minRows: 2,
  },
};

const shapeName = arg('shape') || 'accordion';
const shape = SHAPES[shapeName];
if (!shape) {
  console.error(`Unknown --shape "${shapeName}". Known: ${Object.keys(SHAPES).join(', ')}`);
  process.exit(1);
}

const rowsContainer = shape.container.exec(html);
if (!rowsContainer) {
  console.error(`Could not locate the repeating-row container for shape "${shapeName}" in ${file}.`);
  process.exit(1);
}

const rows = rowsContainer[2];
const rowMatches = [...rows.matchAll(shape.row)];
if (rowMatches.length < shape.minRows) {
  console.error(`Found ${rowMatches.length} repeating row(s); need at least ${shape.minRows}.`);
  process.exit(1);
}

const first = rowMatches[0][0].replace(/^\n/, '');
let row = first;
for (const [re, slot] of shape.slots) {
  if (!re.exec(row)) {
    console.error(`Could not locate the ${slot} slot in the first row.`);
    process.exit(1);
  }
  row = row.replace(re, `$1{{${slot}}}$3`);
}
// Every Alpine reference to this row's ordinal becomes {{INDEX}}. Done after
// the content swap so a number inside the content can't be caught.
row = row
  .replace(/activeIndex === 1 &&/g, 'activeIndex === {{INDEX}} &&')
  .replace(/activeIndex === 1\b/g, 'activeIndex === {{INDEX}}')
  .replace(/\? null : 1\b/g, '? null : {{INDEX}}');

// Indentation is preserved for {{ROWS}} and the closing tags so the repaired
// file still reads like the file a human wrote. Losing it produced a diff full
// of gratuitous whitespace changes on pages that were otherwise correct.
const indent = /(^|\n)([ \t]*)$/.exec(html.slice(0, rowsContainer.index + rowsContainer[1].length).replace(rowsContainer[1], ''))?.[2] ?? '';
const wrapper = `${html.slice(0, rowsContainer.index)}${rowsContainer[1]}\n{{ROWS}}\n${indent}${rowsContainer[3]}`;

const template = { wrapper: wrapper.trim(), row: row.replace(/\s+$/, '') };

const check = validatePlaceholders(type, template);
if (!check.ok) {
  console.error(`Captured template fails the placeholder contract: ${check.error}`);
  process.exit(1);
}

console.log(`Captured "${type}" from ${file} (${rowMatches.length} example rows)\n`);
console.log('--- wrapper ---');
console.log(template.wrapper);
console.log('\n--- row ---');
console.log(template.row);

const { rows: siteRows } = await query('select * from sites where id = $1', [siteId]);
const site = siteRows[0];
const pageUrl = page || sitePageUrl(site);
const verified = await verifyTemplateAgainstLiveSite(type, template, { pageUrl })
  .catch((err) => ({ ok: false, reason: 'unreachable', error: err.message }));
console.log(`\nverification (against ${pageUrl}): ${verified.ok ? 'PASSED' : `FAILED (${verified.reason}${verified.error ? `: ${verified.error}` : ''})`}`);
if (!verified.ok) process.exit(1);

if (!commit) {
  console.log('\nDry run. Re-run with --commit to store it.');
  process.exit(0);
}

const urlFileMap = site.url_file_map || {};
const siteRoot = urlFileMap.siteRoot || {};

if (page) {
  // Explicit --page: this is a claim about ONE real page, not the whole
  // site, so it is stored in the page-scoped tier design-drift.js's
  // resolvePageComponentTemplate reads FIRST (more specific than the
  // site-level entry) — never overwrites componentTemplates[key], which
  // stays reserved for a template genuinely verified as shared.
  const fileKey = pageTemplateFileKey(site, page);
  const existingStore = siteRoot.pageComponentTemplates || {};
  const existingForKey = existingStore[key] || {};
  await query('update sites set url_file_map = $1 where id = $2', [{
    ...urlFileMap,
    siteRoot: {
      ...siteRoot,
      pageComponentTemplates: {
        ...existingStore,
        [key]: {
          byUrl: { ...existingForKey.byUrl, [page]: verified.stamped },
          ...(fileKey ? { byFile: { ...existingForKey.byFile, [fileKey]: verified.stamped } } : (existingForKey.byFile ? { byFile: existingForKey.byFile } : {})),
        },
      },
    },
  }, siteId]);
  console.log(`\nStored as pageComponentTemplates.${key}.byUrl["${page}"]${fileKey ? ` (and .byFile["${fileKey}"])` : ''} for site ${siteId}.`);
  process.exit(0);
}

await query('update sites set url_file_map = $1 where id = $2', [{
  ...urlFileMap,
  siteRoot: {
    ...siteRoot,
    componentTemplates: { ...siteRoot.componentTemplates, [key]: verified.stamped },
  },
}, siteId]);
console.log(`\nStored as componentTemplates.${key} for site ${siteId}.`);
process.exit(0);
