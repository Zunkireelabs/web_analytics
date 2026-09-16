#!/usr/bin/env node
// Stores a hand-authored "inline" FAQ/Q&A template for a site's blog/article
// pages — a distinct, smaller-scale companion to componentTemplates.faq (the
// site's real section-scale accordion, used on the homepage/contact/careers
// and capped by visible_faq_cap). marker-merge.js's buildMergeValues picks
// this one instead whenever the target page classifies as inline content
// (blog-article/legal/other — see isInlineContentPage).
//
// Not captured from an existing example (blog posts never had a correct one
// to capture from) — authored to match the site's own real blog-article
// prose typography (read directly off a live post's `prose`/`prose-h3`/
// `prose-p` modifiers), then verified the same way a captured template is:
// every literal class must actually exist in the site's shipped CSS.
//
//   node server/scripts/store-inline-faq-template.js --site 1 \
//     --wrapper-file <path> --row-file <path> [--commit]
//
// Simpler alternative for a one-off template: pass --wrapper and --row as
// inline strings instead of files.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { query } from '../db.js';
import {
  validatePlaceholders, sitePageUrl, extractLiteralClassNames, extractStylesheetHrefs,
  classExistsInCss, fetchText, stampTemplateVerification, TEMPLATE_VERIFIED_BY,
} from '../implementers/lib/design-drift.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const siteId = Number(arg('site'));
const key = arg('key') || 'faqInline';
const actionType = arg('action-type') || 'faq';
const commit = process.argv.includes('--commit');

const wrapperFile = arg('wrapper-file');
const rowFile = arg('row-file');
const wrapper = wrapperFile ? await readFile(wrapperFile, 'utf8') : arg('wrapper');
const row = rowFile ? await readFile(rowFile, 'utf8') : arg('row');

if (!siteId || !wrapper || !row) {
  console.error('Usage: store-inline-faq-template.js --site <id> (--wrapper-file <path> | --wrapper <html>) (--row-file <path> | --row <html>) [--key faqInline] [--commit]');
  process.exit(1);
}

const template = { wrapper: wrapper.trim(), row: row.trim() };

const check = validatePlaceholders(actionType, template);
if (!check.ok) {
  console.error(`Template fails the placeholder contract: ${check.error}`);
  process.exit(1);
}

console.log(`Template for componentTemplates.${key} (site ${siteId}):\n`);
console.log('--- wrapper ---');
console.log(template.wrapper);
console.log('\n--- row ---');
console.log(template.row);

const { rows: siteRows } = await query('select * from sites where id = $1', [siteId]);
const site = siteRows[0];
if (!site) {
  console.error(`No site ${siteId}.`);
  process.exit(1);
}

// Not a captured example, so verifyTemplateAgainstLiveSite's structural
// match (does this exact wrapper/row shape appear on the live page) will
// always fail — there's nothing to find yet. What DOES apply, same bar as a
// captured template: every literal class this hand-authored markup uses
// must actually exist in the site's shipped CSS, not be a guess.
const pageUrl = sitePageUrl(site);
const html = await fetchText(pageUrl);
if (!html) {
  console.error(`Could not fetch ${pageUrl} to verify classes.`);
  process.exit(1);
}
const hrefs = extractStylesheetHrefs(html).map((h) => new URL(h, pageUrl).href);
const sheets = (await Promise.all(hrefs.map((h) => fetchText(h)))).filter(Boolean);
const css = sheets.join('\n');
const classes = extractLiteralClassNames(template);
const missing = classes.filter((c) => !classExistsInCss(c, css));
console.log(`\nverification: ${missing.length ? `FAILED — missing from live CSS: ${missing.join(', ')}` : `PASSED (${classes.length} classes checked)`}`);
if (missing.length) process.exit(1);

if (!commit) {
  console.log('\nDry run. Re-run with --commit to store it.');
  process.exit(0);
}

const stamped = stampTemplateVerification(template, {
  verifiedBy: TEMPLATE_VERIFIED_BY.FRESHNESS_CHECK,
  verifiedRef: pageUrl,
});
const urlFileMap = site.url_file_map || {};
const siteRoot = urlFileMap.siteRoot || {};
await query('update sites set url_file_map = $1 where id = $2', [{
  ...urlFileMap,
  siteRoot: {
    ...siteRoot,
    componentTemplates: { ...siteRoot.componentTemplates, [key]: stamped },
  },
}, siteId]);
console.log(`\nStored as componentTemplates.${key} for site ${siteId}.`);
process.exit(0);
