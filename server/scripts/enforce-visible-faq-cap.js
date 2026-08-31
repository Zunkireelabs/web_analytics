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

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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

/**
 * @param {string} repoDir  a real directory containing the repo's `src/`
 * @param {number} cap      site.visible_faq_cap
 * @param {string} configuredFaqWrapper  site's componentTemplates.faq.wrapper,
 *   used only to recognise the site's own accordion by the control unique to
 *   it (`expandAll`) rather than by a class name.
 * @param {{write?: boolean}} [opts]
 * @returns {{cap, visibleFound, demoted, changedPaths: string[]}}
 */
export async function enforceVisibleFaqCap(repoDir, cap, configuredFaqWrapper, { write = false } = {}) {
  const ACCORDION_MARK = /expandAll/;
  const visible = [];
  for (const file of walk(path.join(repoDir, 'src'))) {
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
      rel: path.relative(repoDir, file),
      isSiteComponent: ACCORDION_MARK.test(withoutSchema) && ACCORDION_MARK.test(configuredFaqWrapper || ''),
      scripts,
      text,
    });
  }

  if (visible.length <= cap) return { cap, visibleFound: visible.length, demoted: 0, changedPaths: [] };

  // The site's own component first, then alphabetical for a stable, reviewable
  // ordering rather than filesystem order.
  visible.sort((a, b) => (b.isSiteComponent - a.isSiteComponent) || a.rel.localeCompare(b.rel));
  const demote = visible.slice(cap);

  const changedPaths = [];
  for (const v of demote) {
    if (!v.scripts.length) continue; // no schema to fall back to — never silently delete content
    const updated = v.text.replace(REGION, `$1${v.scripts.join('')}$3`);
    changedPaths.push(v.rel);
    if (write) await writeFile(v.file, updated);
  }
  return { cap, visibleFound: visible.length, demoted: changedPaths.length, changedPaths };
}

// CLI entrypoint only — importing this module must never parse argv or exit.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { query } = await import('../db.js');

  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
  };
  const siteId = Number(arg('site'));
  const repo = arg('repo');
  const write = process.argv.includes('--write');
  if (!siteId || !repo) {
    console.error('Usage: enforce-visible-faq-cap.js --site <id> --repo <path> [--write]');
    process.exit(1);
  }

  const { rows } = await query('select visible_faq_cap, url_file_map from sites where id = $1', [siteId]);
  if (!rows.length) { console.error(`No site ${siteId}.`); process.exit(1); }
  const cap = rows[0].visible_faq_cap;
  if (cap == null) { console.error(`Site ${siteId} has no visible_faq_cap set — nothing to enforce.`); process.exit(1); }

  const result = await enforceVisibleFaqCap(
    repo, cap, rows[0].url_file_map?.siteRoot?.componentTemplates?.faq?.wrapper, { write },
  );
  console.log(`visible_faq_cap = ${result.cap}; found ${result.visibleFound} page(s) with a visible FAQ.\n`);
  if (result.demoted) {
    console.log('DEMOTED to schema-only:');
    for (const p of result.changedPaths) console.log(`   ${p}`);
  } else {
    console.log('Within the cap — nothing to do.');
  }
  console.log(`\n${result.visibleFound} -> ${result.visibleFound - result.demoted} visible FAQ page(s).`);
  console.log(write ? 'Written.' : 'Dry run — re-run with --write to apply.');
  process.exit(0);
}
