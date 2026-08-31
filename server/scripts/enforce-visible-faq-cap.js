#!/usr/bin/env node
// Brings a tenant repo back within its visible-FAQ ceiling by demoting the
// excess pages to schema-only.
//
// WHY THIS EXISTS
//
// sites.visible_faq_cap is a real sitewide policy: a handful of pages get a
// visible FAQ accordion, and every other page that has FAQ content carries it
// as FAQPage JSON-LD only. That is a deliberate editorial decision — a site
// where every page ends in an accordion reads as SEO filler, and duplicated
// visible FAQ blocks compete with each other.
//
// The cap is enforced at DRAFT time (render-inspector.js decides a new draft's
// render mode from visibleFaqCount vs visibleFaqCap). Nothing enforces it
// retroactively, so a period when the count was wrong — or drafts approved
// faster than the count updated — leaves the repo permanently over its ceiling
// with no signal. zunkireelabs.com sat at 7 visible against a cap of 5.
//
// Demotion is lossless: every one of these regions already contains its own
// FAQPage JSON-LD alongside the visible markup, so removing the visible half
// keeps the structured data exactly as it was. A region WITHOUT schema is never
// demoted — that would silently delete content — it is reported instead.
//
// WHICH PAGES KEEP THEIR ACCORDION: the ones already using the site's own
// component. A page rendered with the real accordion was built deliberately;
// one rendered with the projection fallback is where the agent reached past the
// cap. Ties break toward the file that has been there longest.
//
//   node server/scripts/enforce-visible-faq-cap.js --site 1 --repo <path>
//   node server/scripts/enforce-visible-faq-cap.js --site 1 --repo <path> --write

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { query } from '../db.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const siteId = Number(arg('site'));
const repo = arg('repo');
const write = process.argv.includes('--write');
if (!siteId || !repo) {
  console.error('Usage: enforce-visible-faq-cap.js --site <id> --repo <path> [--write]');
  process.exit(1);
}

const { rows } = await query('select visible_faq_cap, url_file_map from sites where id = $1', [siteId]);
if (!rows.length) {
  console.error(`No site ${siteId}.`);
  process.exit(1);
}
const cap = rows[0].visible_faq_cap;
if (cap == null) {
  console.error(`Site ${siteId} has no visible_faq_cap set — nothing to enforce.`);
  process.exit(1);
}

// The site's own accordion, identified by the component it actually uses
// rather than by a class name: the expand-all control is unique to it.
const configuredFaq = rows[0].url_file_map?.siteRoot?.componentTemplates?.faq?.wrapper || '';
const ACCORDION_MARK = /expandAll/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const REGION = /(<!--\s*SEOAI:FAQ:START\s*-->)([\s\S]*?)(<!--\s*SEOAI:FAQ:END\s*-->)/;
const SCHEMA = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi;

const visible = [];
for (const file of walk(path.join(repo, 'src'))) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch { continue; }
  const m = REGION.exec(text);
  if (!m) continue;
  const body = m[2].trim();
  if (!body) continue;

  const scripts = body.match(SCHEMA) || [];
  const withoutSchema = body.replace(SCHEMA, '').trim();
  if (!withoutSchema) continue; // already schema-only

  visible.push({
    file,
    rel: path.relative(repo, file),
    isSiteComponent: ACCORDION_MARK.test(withoutSchema) && ACCORDION_MARK.test(configuredFaq),
    scripts,
    text,
    region: m,
  });
}

console.log(`visible_faq_cap = ${cap}; found ${visible.length} page(s) with a visible FAQ.\n`);
if (visible.length <= cap) {
  console.log('Within the cap — nothing to do.');
  process.exit(0);
}

// The site's own component first, then alphabetical for a stable, reviewable
// ordering rather than filesystem order.
visible.sort((a, b) => (b.isSiteComponent - a.isSiteComponent) || a.rel.localeCompare(b.rel));

const keep = visible.slice(0, cap);
const demote = visible.slice(cap);

console.log('KEEPING visible:');
for (const v of keep) console.log(`   ${v.isSiteComponent ? 'site accordion' : 'other        '}  ${v.rel}`);
console.log('\nDEMOTING to schema-only:');

let demoted = 0;
for (const v of demote) {
  if (!v.scripts.length) {
    console.log(`   SKIPPED (no FAQPage schema in the region — demoting would delete content): ${v.rel}`);
    continue;
  }
  const updated = v.text.replace(REGION, `$1${v.scripts.join('')}$3`);
  console.log(`   ${v.rel}  (${v.scripts.length} schema block(s) preserved)`);
  demoted++;
  if (write) await writeFile(v.file, updated);
}

console.log(`\n${visible.length} -> ${visible.length - demoted} visible FAQ page(s).`);
console.log(write ? 'Written.' : 'Dry run — re-run with --write to apply.');
process.exit(0);
