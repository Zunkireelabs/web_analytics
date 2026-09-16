#!/usr/bin/env node
// Records REAL, measured design tokens onto a site's stored designProfile.
//
// WHY THIS EXISTS
//
// The Design Agent derives a profile by loading a couple of pages and asking
// an LLM to summarise them. That works well for a site with one coherent
// stylesheet, and badly for a site whose styling is per-page inline CSS with
// no shared system — it generalises whatever the homepage happened to use and
// leaves the fields it couldn't confidently infer as null.
//
// Chayce (site 8864) is the worst case of that: every page ships its own
// <style> block (index 198 lines, about 155, faq 97, news 64) over a scraped
// WordPress theme, so class names are PAGE-SCOPED and don't transfer. Its
// derived profile had color.{accent,text,muted,border,surface} ALL null,
// despite #c8a96e appearing 89 times across its pages and being the entire
// brand. A generator reading that profile has nothing to ground a colour in.
//
// This fills those gaps from real measurement (counted occurrences across the
// site's own live pages), not from a guess. It only PATCHES the keys given —
// everything else on the profile is left exactly as the agent derived it, so
// this never silently overwrites real derived evidence with hand input.
//
//   node server/scripts/record-design-tokens.js --site 8864 --file tokens.json
//   ... --commit
//
// tokens.json is a partial designProfile: { color: {...}, styling: "...", ... }.
// Nested objects are merged one level deep (color.accent can be set without
// clearing color.text); anything else replaces wholesale.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { query } from '../db.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const siteId = Number(arg('site'));
const file = arg('file');
const commit = process.argv.includes('--commit');

if (!siteId || !file) {
  console.error('Usage: record-design-tokens.js --site <id> --file <tokens.json> [--commit]');
  process.exit(1);
}

const patch = JSON.parse(await readFile(file, 'utf8'));

const { rows } = await query('select id, name, url_file_map from sites where id = $1', [siteId]);
const site = rows[0];
if (!site) {
  console.error(`No site ${siteId}.`);
  process.exit(1);
}

const urlFileMap = site.url_file_map || {};
const siteRoot = urlFileMap.siteRoot || {};
const profile = siteRoot.designProfile;
if (!profile) {
  console.error(`Site ${siteId} has no designProfile yet — derive one first rather than creating one by hand.`);
  process.exit(1);
}

// One level deep: a plain object patch merges into the existing object of the
// same key, so setting color.accent doesn't wipe color.text. Anything else
// (string, array, null) replaces.
const merged = { ...profile };
for (const [key, value] of Object.entries(patch)) {
  const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  merged[key] = (isPlainObject(value) && isPlainObject(profile[key]))
    ? { ...profile[key], ...value }
    : value;
}

for (const key of Object.keys(patch)) {
  console.log(`--- ${key} ---`);
  console.log('  before:', JSON.stringify(profile[key]));
  console.log('  after: ', JSON.stringify(merged[key]));
}

if (!commit) {
  console.log('\nDry run. Re-run with --commit to store it.');
  process.exit(0);
}

await query('update sites set url_file_map = $1 where id = $2', [{
  ...urlFileMap,
  siteRoot: { ...siteRoot, designProfile: merged },
}, siteId]);
console.log(`\nRecorded ${Object.keys(patch).length} design-token key(s) for site ${siteId} (${site.name}).`);
process.exit(0);
