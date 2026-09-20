#!/usr/bin/env node
// Re-renders the content already spliced into a tenant repo's SEOAI marker
// regions, using that site's CURRENT (corrected) component templates.
//
// WHY THIS EXISTS
//
// repair-design-profile-roles.js fixes the templates a site will use from now
// on. It cannot fix what already shipped: every block spliced into the repo
// while the templates were wrong is still sitting in the tenant's files,
// rendering body copy in the site's eyebrow style, headings at hero size, and
// expand-content blocks outside the site container.
//
// The TEXT in those blocks is fine — a human reviewed and merged it. Only the
// markup around it is wrong. So this does not regenerate anything and makes no
// model call: it parses each marker region back into its content slots
// (question/answer, heading/body), then re-renders them through the exact same
// renderFaqHtml / renderQaHtml / renderExpandedHtml the implementer uses, with
// the corrected template. The output is byte-identical to what the fixed
// pipeline would produce for that same content, so the repair and the pipeline
// can never disagree.
//
// SAFETY: only bytes BETWEEN a marker's START and END comments are ever
// rewritten. Everything else in the file — the site's own hand-written markup,
// which legitimately uses the same eyebrow classes for actual eyebrows — is
// untouched, and a region that fails to parse is skipped and reported rather
// than guessed at.
//
//   node server/scripts/repair-site-marker-styling.js --site 1 --repo /path/to/checkout
//   node server/scripts/repair-site-marker-styling.js --site 1 --repo /path/to/checkout --write

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { fillTemplate, renderFromTemplate, escapeHtml, proseStyleFor } from '../implementers/lib/marker-merge.js';

// Marker name -> how to parse its content back out, and how to re-render it.
// Parsers return null when the region is not in a shape they recognise, which
// is the signal to leave it completely alone. Built fresh per call from the
// site's own componentTemplates, rather than a module-level constant, so this
// module can be called for many sites in one process (job.js/cron.js) without
// one site's templates leaking into another's repair.
function buildHandlers(templates, proseStyle = {}) {
  return {
  FAQ: {
    template: templates.faq,
    parse(html) {
      const $ = cheerio.load(html, null, false);
      const items = [];
      // The site's real accordion FIRST. Its rows are a trigger <button> whose
      // sibling is an x-show panel — matching on x-show rather than on "the
      // first div near a button" is what stops the site's own expand-all
      // control (also a <button>, with no panel) from being read as a question.
      $('[x-show]').each((i, panel) => {
        const trigger = $(panel).prevAll('button').first();
        if (!trigger.length) return;
        items.push({ question: trigger.text().trim(), answer: unwrapSlot($, $(panel).children()) });
      });
      // Then the definition list the projection falls back to.
      if (!items.length) {
        $('dt').each((i, dt) => {
          const dd = $(dt).next('dd');
          if (dd.length) items.push({ question: $(dt).text().trim(), answer: dd.html().trim() });
        });
      }
      return items.length ? items : null;
    },
    render: (items, tpl) => renderSlots(items, tpl, (it) => ({
      // The captured accordion puts {{ANSWER}} inside its own <p class="pt-4
      // ...">. An answer that is already a single <p> would nest one inside the
      // other, which is invalid and which browsers silently split into two
      // paragraphs — so the redundant wrapper is dropped.
      QUESTION: escapeHtml(it.question), ANSWER: dropOuterParagraph(it.answer, tpl.row, 'ANSWER'),
    }), (it) => blockSafeRow(tpl.row, it.answer, 'ANSWER')),
  },
  QACONTENT: {
    template: templates.qaContent,
    parse(html) {
      const $ = cheerio.load(html, null, false);
      const items = [];
      $('details').each((i, d) => {
        const summary = $(d).find('summary').first();
        const question = summary.text().trim();
        // Everything in the <details> that is not the <summary> is the answer.
        const answer = unwrapSlot($, $(d).children().not('summary'));
        if (question && answer) items.push({ question, answer });
      });
      return items.length ? items : null;
    },
    render: (items, tpl) => renderSlots(items, tpl, (it) => ({
      QUESTION: escapeHtml(it.question), ANSWER: dropOuterParagraph(normaliseTables(it.answer), tpl.row, 'ANSWER'),
    }), (it) => blockSafeRow(tpl.row, normaliseTables(it.answer), 'ANSWER')),
  },
  EXPANDEDCONTENT: {
    template: templates.expandContent,
    parse(html) {
      const $ = cheerio.load(html, null, false);
      const items = [];
      // Heading + the markup that follows it, at whatever nesting depth the
      // template that produced this used. Anchoring on the heading rather than
      // on a wrapper class is what makes this work across every template
      // generation this site has shipped. h1 is included alongside h2/h3:
      // confirmed live on site 8864 (chayceproperties.com, 2026-09-20) —
      // buildMergeValues spliced these regions using a stale
      // componentTemplates.expandContent row that was itself a bare,
      // unclassed `<h1>` (since corrected by freshness-check, but not
      // retroactively). Since this parser only ever runs on the isolated
      // text BETWEEN a marker's own START/END comments — never the host
      // page's real markup outside it — any heading tag found here was
      // written by this platform's own template, so matching h1 can never
      // misparse the page's own real <h1>. Excluding it silently left every
      // such region unrecognised ("unrecognised shape, left as-is") forever,
      // even after the template that produced it was fixed and the daily
      // repair cron (repair-site-content-live.js) ran again.
      $('h1, h2, h3').each((i, h) => {
        const heading = $(h).text().trim();
        const body = unwrapSlot($, $(h).nextAll());
        if (heading && body) items.push({ heading, body });
      });
      return items.length ? items : null;
    },
    render: (items, tpl) => renderSlots(items, tpl, (it) => ({
      HEADING: escapeHtml(it.heading), BODY: dropOuterParagraph(normaliseProse(normaliseTables(it.body), proseStyle), tpl.row, 'BODY'),
    }), (it) => blockSafeRow(tpl.row, normaliseProse(normaliseTables(it.body), proseStyle), 'BODY')),
  },
  };
}

// Deliberately NOT marker-merge's renderFaqHtml / renderQaHtml /
// renderExpandedHtml. Those take a draft's RAW content — plain-text answers,
// markdown bodies — and escape or markdown-convert it on the way in. Here the
// input is already-rendered HTML pulled back out of a shipped file, so running
// it through them again double-escapes: a real paragraph became the literal
// text "&lt;p&gt;..." on the page.
//
// The slot rules differ by how each value was extracted, which is why this
// can't be one blanket policy:
//   - question/heading come from .text(), i.e. DECODED, so they must be
//     re-escaped or an "&" or "<" in a heading corrupts the markup;
//   - answer/body come from .html(), i.e. still escaped, so they go in
//     verbatim and any inline markup in them survives.
// The wrapper/row assembly itself is still marker-merge's, so the result is
// byte-identical to the pipeline's for the same slot values.
function renderSlots(items, template, slotsOf, rowFor = () => template.row) {
  return renderFromTemplate(
    template,
    items.map((item, i) => fillTemplate(rowFor(item), { INDEX: String(i + 1), ...slotsOf(item) })),
  );
}

// The body/answer slot in every projected template is a bare <div> wrapper
// whose class IS the styling being repaired. Extracting that div verbatim
// would carry the old eyebrow class straight into the new template's slot —
// the markup would change and the page would look exactly as wrong. So a
// single <div> is unwrapped to its contents.
//
// A single <p> is NOT unwrapped: an older, correct template on this site puts
// body copy in a classed <p> directly rather than in a slot wrapper, and
// stripping that would drop the paragraph element itself. Multiple elements
// are never a slot wrapper either.
// True when the template already provides the paragraph around its answer
// slot, in which case an answer that is itself one <p> should contribute only
// its contents.
// A marker region can legitimately hold BOTH the visible component and the
// JSON-LD that describes it — every FAQ region on this site ends with its
// FAQPage schema inside the same markers. Re-rendering only the visible part
// and writing that back silently deleted the schema from seven pages, which
// would have cost the site its FAQ rich results. The scripts are lifted out
// before parsing and put back afterwards, byte for byte.
function extractSchemaBlocks(html) {
  const scripts = [];
  const stripped = html.replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, (m) => {
    scripts.push(m);
    return '';
  });
  return { stripped, scripts };
}

// The captured section template puts {{BODY}} inside a <p>, because the real
// example on the site is one paragraph of prose. Generated bodies are not: they
// carry tables, lists and several paragraphs, and a <table> inside a <p> is
// invalid HTML that browsers fix by closing the <p> early, stranding the table
// outside the styled wrapper. Same class, same visual result, valid either way.
const BLOCK_LEVEL = /<(table|ul|ol|div|h[1-6]|blockquote|pre|figure|section)[\s>]/i;
function blockSafeRow(rowTemplate, body, slot) {
  if (!BLOCK_LEVEL.test(body)) return rowTemplate;
  const re = new RegExp(`<p(\\s[^>]*)?>(\\s*\\{\\{${slot}\\}\\}\\s*)</p>`);
  return rowTemplate.replace(re, (m, attrs, inner) => `<div${attrs || ''}>${inner}</div>`);
}

function dropOuterParagraph(value, rowTemplate, slot) {
  const wrapped = new RegExp(`<p[^>]*>\\s*\\{\\{${slot}\\}\\}`).test(rowTemplate);
  if (!wrapped) return value;
  const m = /^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/.exec(value.trim());
  // Only when the whole value is ONE paragraph — otherwise the inner content
  // has structure of its own and blockSafeRow has already swapped the <p>
  // wrapper for a <div>.
  return m && !/<p[\s>]/i.test(m[1]) ? m[1].trim() : value;
}

function unwrapSlot($, elements) {
  if (elements.length === 1) {
    const only = elements.first();
    if (only.prop('tagName') === 'DIV') return (only.html() || '').trim();
  }
  return elements.map((i, el) => $.html(el)).get().join('').trim();
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Not every block the platform writes lives between markers. The
// data-array-content adapter puts expand-content straight into a STRING FIELD
// of an Eleventy data file (src/_data/locations.js, comparisons.js) — that is
// how a page rendered from a shared layout over a data array gets its content,
// since there is no per-page file to splice into.
//
// It is the same markup from the same template, so it carries the same defect,
// but a marker-only repair walks straight past it: on this site that left ten
// /locations/* and /compare/* pages still rendering body copy as uppercase
// labels after every marker on the site was clean.
const DATA_FIELD = /(\bexpandedContent\s*:\s*)("(?:[^"\\]|\\.)*")/g;

// A blog post's body is rendered INSIDE blog-post.njk's `prose` wrapper, which
// already styles every heading, paragraph, list and link in it. Content
// injected there must therefore carry no sizing classes of its own: the
// projected template's `text-3xl md:text-4xl lg:text-5xl` heading sat next to
// the author's own `##` headings, which prose renders at
// `text-2xl md:text-3xl` — so every agent-written section announced itself by
// being visibly larger than the human-written ones around it.
//
// Bare tags inherit prose exactly, which makes injected sections
// indistinguishable from the post's own. This is not a different design, it is
// the ABSENCE of a competing one, and it only applies inside a prose host.
// FAQ was missing here (2026-09-09): a blog post's FAQ marker fell through
// to `handler.template` below — the site's real captured template, built for
// a full-bleed page SECTION (e.g. `container-custom py-12 md:py-20`) — and
// carried that section's own width/padding straight into the post's already-
// constrained prose column, the same "carries its own sizing classes into a
// prose host" defect this whole PROSE_TEMPLATES table exists to prevent for
// EXPANDEDCONTENT/QACONTENT. <dt>/<dd> is DEFAULT_FAQ_TEMPLATE's own bare
// shape (marker-merge.js) — same "zero sizing classes, let prose style it"
// contract as the other two rows here.
const PROSE_TEMPLATES = {
  EXPANDEDCONTENT: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2>{{HEADING}}</h2>\n{{BODY}}' },
  QACONTENT: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h3>{{QUESTION}}</h3>\n{{ANSWER}}' },
  FAQ: { wrapper: '<dl>\n{{ROWS}}\n</dl>', row: '<dt>{{QUESTION}}</dt>\n<dd>{{ANSWER}}</dd>' },
};

// hostIsProse (below) used to be file.endsWith('.md') alone — a proxy for
// "is this page a blog-article, the one page type PROSE_TEMPLATES was built
// for". That proxy misses every OTHER prose-flow page type marker-merge.js's
// own isInlineContentPage protects live (a 'legal' page — privacy/terms/
// cookie policy — gets the same "small addition inside body copy" treatment
// there, and on this site those pages are .njk, not .md). Confirmed live on
// site 1 (2026-09-18): src/pages/privacy-policy-zunkiree-labs.njk's
// EXPANDEDCONTENT wrapper still carried `py-12 md:py-20` section-scale
// spacing — the exact defect this table exists to prevent — because the old
// `.md`-only check never classified it as a prose host at all, so a repair
// run would have kept re-applying `handler.template`'s full section styling
// forever instead of ever converging on the bare, prose-inherited shape.
// Matches classifyPageType's own 'legal' regex (design-agent/live-analysis/
// schema.js) against the file's basename — the closest available signal to
// a URL path here, since this script repairs a materialized file tree, not
// live pages with known URLs.
const LEGAL_FILE_RE = /\b(terms|privacy|cookies?|legal)\b/i;

// The site's own comparison-table convention (src/pages/agentic-as-a-service.njk).
// Generated tables shipped as a bare <table> with no classes at all, or with a
// different one-off class list each time — nine distinct shapes across the site.
const TABLE = {
  wrap: 'mb-10 overflow-hidden rounded-lg border border-gray-200',
  table: 'w-full text-sm',
  thead: 'bg-gray-50',
  th: 'px-4 py-3 text-left font-medium text-gray-900',
  tbody: 'divide-y divide-gray-200',
  td: 'px-4 py-3 text-gray-600',
  tdFirst: 'px-4 py-3 font-medium text-gray-900',
};

// Restyles every table in a fragment to the site's convention. Structure and
// cell content are never touched — only the class attributes — so a table that
// is already correct comes out byte-identical.
function normaliseTables(html) {
  const $ = cheerio.load(html, null, false);
  $('table').each((i, t) => {
    const $t = $(t);
    $t.attr('class', TABLE.table);
    $t.find('thead').attr('class', TABLE.thead);
    $t.find('tbody').attr('class', TABLE.tbody);
    $t.find('th').attr('class', TABLE.th);
    $t.find('tr').each((j, tr) => {
      $(tr).find('td').each((k, td) => $(td).attr('class', k === 0 ? TABLE.tdFirst : TABLE.td));
    });
    // The rounded border lives on a wrapper so the table can scroll on narrow
    // screens without the corners clipping.
    if (!$t.parent().hasClass('overflow-hidden')) $t.wrap(`<div class="${TABLE.wrap}"></div>`);
  });
  return $.html();
}

// The retroactive half of the 2026-09-15 expand-content prose fix
// (marker-merge.js's proseStyleFor/markdownToHtml, generators/lib/
// rendered-markup-guard.js's regression check): every expand-content block
// already SHIPPED before that fix spliced its body as bare, unstyled
// <p>/<ul>/<li>/<a> — same "flat" defect normaliseTables above already
// retroactively fixes for tables, just never extended to prose. Only ADDS a
// class to a tag that has none; a paragraph/list/link that already carries
// a real class (e.g. from a captured template's own row wrapper, or a
// prior run of this repair) is left completely alone, so this is safe to
// run repeatedly and never overwrites a real, intentional class with a
// generic one.
function normaliseProse(html, proseStyle) {
  if (!proseStyle?.bodyClass && !proseStyle?.linkClass && !proseStyle?.listWrapperClass && !proseStyle?.listItemClass) return html;
  const $ = cheerio.load(html, null, false);
  if (proseStyle.bodyClass) $('p').not('[class]').addClass(proseStyle.bodyClass);
  if (proseStyle.listWrapperClass) $('ul').not('[class]').addClass(proseStyle.listWrapperClass);
  if (proseStyle.listItemClass) $('li').not('[class]').addClass(proseStyle.listItemClass);
  if (proseStyle.linkClass) $('a[href^="http"]').not('[class]').addClass(proseStyle.linkClass);
  return $.html();
}

async function repairDataFile(file, handlers, write) {
  const text = await readFile(file, 'utf8');
  if (!DATA_FIELD.test(text)) return 0;
  DATA_FIELD.lastIndex = 0;

  const handler = handlers.EXPANDEDCONTENT;
  if (!handler.template) return 0;

  let count = 0;
  const updated = text.replace(DATA_FIELD, (whole, prefix, literal) => {
    let inner;
    try {
      // These are plain double-quoted literals with \" and \n escapes, which
      // JSON parses identically. Anything fancier (a template literal, single
      // quotes) simply won't match DATA_FIELD in the first place.
      inner = JSON.parse(literal);
    } catch {
      return whole;
    }
    const { stripped, scripts } = extractSchemaBlocks(inner);
    const items = handler.parse(stripped);
    if (!items) return whole;
    const rendered = `${handler.render(items, handler.template)}${scripts.join('')}`;
    if (rendered.trim() === inner.trim()) return whole;
    count++;
    return `${prefix}${JSON.stringify(rendered)}`;
  });

  if (count && write) await writeFile(file, updated);
  return count;
}

/**
 * @param {string} repoDir a real directory containing the repo's `src/`
 * @param {object} templates site.url_file_map.siteRoot.componentTemplates
 * @param {{write?: boolean, designProfile?: object}} [opts] designProfile
 *   (site.url_file_map.siteRoot.designProfile) grounds normaliseProse's
 *   retroactive body/link/list class injection — omitted, EXPANDEDCONTENT
 *   bodies keep whatever prose classing they already shipped with, same as
 *   before this parameter existed.
 * @returns {{changedFiles: number, changedRegions: number, dataFields: number, skipped: number}}
 */
export async function repairSiteMarkerStyling(repoDir, templates, { write = false, designProfile = null } = {}) {
  const handlers = buildHandlers(templates, proseStyleFor(designProfile));
  const files = walk(path.join(repoDir, 'src'));
  let changedFiles = 0;
  let changedRegions = 0;
  let skipped = 0;

  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('SEOAI:')) continue;

    let updated = text;
    const regionNotes = [];

    for (const [name, handler] of Object.entries(handlers)) {
      if (!handler.template) continue;
      const pattern = new RegExp(`(<!--\\s*SEOAI:${name}:START\\s*-->)([\\s\\S]*?)(<!--\\s*SEOAI:${name}:END\\s*-->)`, 'g');
      updated = updated.replace(pattern, (whole, start, body, end) => {
        const inner = body.trim();
        if (!inner) return whole; // an empty marker is a placeholder, not damage

        const { stripped, scripts } = extractSchemaBlocks(inner);
        const items = handler.parse(stripped);
        if (!items) {
          skipped++;
          regionNotes.push(`    ? ${name} — unrecognised shape, left as-is`);
          return whole;
        }

        // A markdown post (or a legal page — see LEGAL_FILE_RE above) is
        // hosted inside the layout's prose wrapper; any other .njk page
        // template is not, and needs the full standalone component.
        const hostIsProse = file.endsWith('.md') || LEGAL_FILE_RE.test(path.basename(file));
        const template = (hostIsProse && PROSE_TEMPLATES[name]) || handler.template;
        const rendered = `${handler.render(items, template)}${scripts.join('')}`;
        if (rendered.trim() === inner) return whole;

        changedRegions++;
        regionNotes.push(`    ~ ${name} — ${items.length} item(s) re-rendered`);
        return `${start}${rendered}${end}`;
      });
    }

    if (updated !== text) {
      changedFiles++;
      if (write) await writeFile(file, updated);
    }
  }

  // Data files are walked separately: their content is not in markers, so the
  // marker loop above never sees it.
  let dataFields = 0;
  for (const file of files.filter((f) => f.includes(`${path.sep}_data${path.sep}`) && f.endsWith('.js'))) {
    const n = await repairDataFile(file, handlers, write);
    if (n) dataFields += n;
  }

  return { changedFiles, changedRegions, dataFields, skipped };
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
    console.error('Usage: repair-site-marker-styling.js --site <id> --repo <path> [--write]');
    process.exit(1);
  }

  const { rows } = await query('select url_file_map from sites where id = $1', [siteId]);
  const templates = rows[0]?.url_file_map?.siteRoot?.componentTemplates;
  const designProfile = rows[0]?.url_file_map?.siteRoot?.designProfile;
  if (!templates) {
    console.error(`Site ${siteId} has no componentTemplates. Run repair-design-profile-roles.js first.`);
    process.exit(1);
  }

  const result = await repairSiteMarkerStyling(repo, templates, { write, designProfile });
  console.log(`\n${result.changedFiles} file(s), ${result.changedRegions} region(s) re-rendered; `
    + `${result.dataFields} data field(s) re-rendered; ${result.skipped} region(s) skipped as unrecognised.`);
  console.log(write ? 'Written.' : 'Dry run — re-run with --write to apply.');
}
