#!/usr/bin/env node
// Removes generated content that shipped with its placeholders still in it.
//
// WHY THIS EXISTS
//
// Two shapes reached zunkireelabs.com's live pages:
//
//  1. Unrendered markdown links — "refer to [Authoritative Source on AI in
//     Search](URL)". The generator emitted markdown into an HTML context AND
//     never resolved the href, so visitors read the literal bracket syntax with
//     the word URL in it.
//
//  2. Comparison tables against a competitor that does not exist — a
//     "Competitor X" column whose cells are "[Competitor Location]",
//     "[Generic solutions]", "[Different focus]". A comparison table is a claim
//     about a real alternative; one built from placeholders is not a weaker
//     claim, it is a fabricated one, and it sits on a page a customer reads
//     before deciding to get in touch.
//
// Both are removed rather than filled in. There is no honest way to invent a
// citation URL or a competitor's real location, and a plausible-looking
// invention on a customer's live site is worse than the placeholder, because
// nobody would ever notice it needed checking.
//
// Removal is bounded: for a link, the sentence containing it; for a table, the
// table and the heading that introduces it. Surrounding real prose is kept.
//
//   node server/scripts/strip-placeholder-content.js --repo <path>
//   node server/scripts/strip-placeholder-content.js --repo <path> --write

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';

// A markdown link whose href was never resolved. The href alternatives are the
// literal placeholders actually observed; a real URL is left alone.
// Not /g: a global regex carries lastIndex between .test() calls, which made
// it skip every other match and silently leave broken links on the page.
const MD_LINK = /\[[^\]]{3,120}\]\((?:URL|url|#)?\)/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Everything is judged at SECTION granularity, not sentence or table
// granularity. A generated block is a heading plus its body, and the two are a
// unit: removing a fabricated table but keeping the "Zunkiree Labs vs
// Competitor X" heading and the four paragraphs that discuss that competitor
// leaves the fabrication in place and merely deletes its evidence. Likewise a
// section whose only content was an unresolved citation must not leave a
// dangling heading over an empty div.
const FICTIONAL = /\bCompetitor\s+[A-Z]\b|\[(?:Competitor|Generic|Support|Different|Specific|Speed)[^\]]{0,40}\]/;
const PLACEHOLDER_CELL = /^\[[A-Z][A-Za-z ]{2,40}\]$/;
const FICTIONAL_HEADER = /^(competitor\s*[a-z]?|\[[^\]]+\])$/i;

function sectionIsFabricated($, el) {
  const text = $(el).text();
  if (MD_LINK.test(text) || FICTIONAL.test(text)) return true;
  return $(el).find('table').toArray().some((t) => {
    const headers = $(t).find('th').map((i, th) => $(th).text().trim()).get();
    if (headers.some((h) => FICTIONAL_HEADER.test(h))) return true;
    return $(t).find('td').toArray().some((td) => PLACEHOLDER_CELL.test($(td).text().trim()));
  });
}

// Returns { html, removed }. Sections are the generated wrapper blocks; when a
// fragment has none (older shapes, data-array content) the whole fragment is
// judged as one unit instead.
function stripFabricatedSections(html) {
  const $ = cheerio.load(html, null, false);
  let removed = 0;
  const sections = $('.mb-8, section.gap-3');
  if (sections.length) {
    sections.each((i, el) => {
      if (!sectionIsFabricated($, el)) return;
      removed++;
      $(el).remove();
    });
  } else if (sectionIsFabricated($, $.root())) {
    return { html: '', removed: 1 };
  }
  if (!removed) return { html, removed: 0 };

  // A wrapper left with no sections at all contributes nothing but padding.
  const out = $.html();
  return { html: /<(h[1-6]|p|table|li)[\s>]/i.test(out) ? out : '', removed };
}

// Refuses to write output that lost markup it should have kept. cheerio
// round-trips are the risky step here: a malformed fragment can come back as
// text, which would silently flatten a page to unstyled prose. Comparing tag
// counts catches that before it reaches a file.
function structureSurvived(before, after) {
  if (!after.trim()) return true; // a deliberate full removal
  const count = (s) => (s.match(/<[a-zA-Z][^>]*>/g) || []).length;
  const removedTags = count(before) - count(after);
  // Removing sections removes tags; losing ALL of them is the failure mode.
  return count(after) > 0 || removedTags === count(before);
}

/**
 * @param {string} repoDir a real directory containing the repo's `src/`
 * @param {{write?: boolean}} [opts]
 * @returns {{totalSections: number, changedFiles: {path: string, sections: number}[]}}
 */
export async function stripPlaceholderContent(repoDir, { write = false } = {}) {
  const files = walk(path.join(repoDir, 'src'));
  let totalSections = 0;
  const changedFiles = [];

  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch { continue; }

    const rel = path.relative(repoDir, file);
    const isData = /_data[\\/].*\.js$/.test(rel);
    let updated = text;
    let sections = 0;

    if (isData) {
      // Data files hold the markup as JS string literals — decode, clean, re-encode.
      updated = text.replace(/(\bexpandedContent\s*:\s*)("(?:[^"\\]|\\.)*")/g, (whole, prefix, literal) => {
        let inner;
        try { inner = JSON.parse(literal); } catch { return whole; }
        const b = stripFabricatedSections(inner);
        if (!b.removed) return whole;
        if (!structureSurvived(inner, b.html)) {
          console.error(`    ! ${rel}: refusing to write — markup did not survive the transform`);
          return whole;
        }
        sections += b.removed;
        return `${prefix}${JSON.stringify(b.html)}`;
      });
    } else {
      updated = text.replace(/(<!--\s*SEOAI:[A-Z]+:START\s*-->)([\s\S]*?)(<!--\s*SEOAI:[A-Z]+:END\s*-->)/g,
        (whole, start, body, end) => {
          const b = stripFabricatedSections(body);
          if (!b.removed) return whole;
          if (!structureSurvived(body, b.html)) {
            console.error(`    ! ${rel}: refusing to write — markup did not survive the transform`);
            return whole;
          }
          sections += b.removed;
          return `${start}${b.html}${end}`;
        });
    }

    if (updated === text) continue;
    changedFiles.push({ path: rel, sections });
    totalSections += sections;
    if (write) await writeFile(file, updated);
  }

  return { totalSections, changedFiles };
}

// CLI entrypoint only — importing this module must never parse argv or exit.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
  };
  const repo = arg('repo');
  const write = process.argv.includes('--write');
  if (!repo) {
    console.error('Usage: strip-placeholder-content.js --repo <path> [--write]');
    process.exit(1);
  }

  const result = await stripPlaceholderContent(repo, { write });
  for (const f of result.changedFiles) {
    console.log(`  ${f.path}`);
    console.log(`    - ${f.sections} section(s) removed (unresolved citation or fictional competitor)`);
  }
  console.log(`\n${result.totalSections} section(s) removed across the site.`);
  console.log(write ? 'Written.' : 'Dry run — re-run with --write to apply.');
}
