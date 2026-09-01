import { analyzePageUrl } from '../agents/lib/page-content.js';
import { buildFontSizeOverrideRemoved } from '../agents/lib/font-consistency-analysis.js';
import { getSiteById } from '../store/read.js';
import { projectTable } from '../design-agent/lib/design-profile.js';

// Repairs the five defect shapes content-integrity.js/font-consistency.js
// detect — broken/empty table markup, comparison content shipped as raw
// delimited text instead of a real <table>, an FAQPage schema whose question
// count has drifted from the real visible FAQ content, a confirmed-duplicate
// visible FAQ section, and a one-element inline font-size override that
// diverges from the rest of the site — using ONLY real facts already,
// verifiably on the page. Never invents table data, an FAQ answer, a
// judgment about which of two visually different FAQ sections is "the
// duplicate," or which CSS class/rule is "correct" for a font-size
// difference — each branch below refuses (throws a 400) rather than guess
// whenever the real page state
// doesn't support a deterministic fix, same discipline generators/
// schema-repair.js and generators/alt-text.js already follow. The actual
// file patch (implementers/lib/content-integrity-inject.js) then only ever
// applies when the exact anchor text is still found byte-for-byte in the
// site's real source, refusing otherwise — this generator's job is only to
// decide WHAT the correct fix is, never to force it onto a source that may
// have changed since detection.
export const meta = {
  id: 'content-integrity-repair',
  name: 'Content Integrity Repair',
  description: 'Removes broken/empty table markup, rebuilds comparison content shipped as raw text into a real table, resyncs FAQ schema with the real visible FAQ content, and removes a confirmed-duplicate visible FAQ section.',
  recommendationTags: [],
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Deterministic transform of rows ALREADY extracted verbatim from the raw
// text (page-content.js's parsePipeRow) — first row is the header, same
// convention as the markdown-table shape this content came from.
//
// `styles` is design-profile.js's projectTable() output — this site's own
// real table pattern when one exists, or one composed from its own real
// typography/color tokens when it doesn't (see projectTable's own comment).
// null (no site, or no profile at all) falls back to bare unstyled markup —
// a real <table> is still a strictly better outcome than the raw pipe text
// it replaces, even with no styling to apply, same "recoverable, never
// worse" floor design-drift.js's own null-projection paths keep elsewhere.
// A horizontal-scroll wrapper is always added regardless of styles found —
// the one structural rule that holds for every tenant, not a style choice.
function buildTableHtml(rows, styles = null) {
  const [header, ...body] = rows;
  const headHtml = `<tr>${header.map((c) => `<th${attr(styles?.headerCellClass)}>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const bodyHtml = body.map((r) => `<tr${attr(styles?.rowClass)}>${r.map((c) => `<td${attr(styles?.cellClass)}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="overflow-x-auto"><table${attr(styles?.tableClass)}><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function attr(cls) {
  return cls ? ` class="${escapeHtml(cls)}"` : '';
}

// Deterministic transform of {question, answer} pairs already extracted
// verbatim from the real visible accordion (page-content.js's
// extractAnswerFor) — same FAQPage shape generators/faq.js already produces
// for net-new FAQ sections, so a repaired schema looks identical in kind to
// a freshly-drafted one.
function buildFaqSchema(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.question,
      acceptedAnswer: { '@type': 'Answer', text: i.answer },
    })),
  };
}

// params: { page: string, fixType: 'malformed-table'|'raw-text-table'|'faq-schema-mismatch'|'duplicate-faq' }
export async function generate({ siteId, params }) {
  const { page, fixType } = params || {};
  if (!page || !fixType) throw Object.assign(new Error('page and fixType are required'), { status: 400 });

  // font-size-override is the one fixType grounded in a LIVE browser capture
  // (font-consistency.js), not a static HTML fetch — analyzePageUrl's
  // cheerio parse of the raw server response can genuinely differ from what
  // a real browser renders (client-side hydration can add/remove attributes
  // after load), so this operates directly on the exact outerHTML the
  // capture observed rather than re-deriving it from a second, different
  // source. Safety still comes from the same place every other fixType's
  // does: the implementer (implementers/lib/content-integrity-inject.js)
  // only ever applies when this exact anchor is still found byte-for-byte
  // in the site's real template SOURCE, refusing otherwise.
  if (fixType === 'font-size-override') {
    const { outerHtml } = params;
    if (!outerHtml) throw Object.assign(new Error('outerHtml is required for fixType "font-size-override"'), { status: 400 });
    const replacement = buildFontSizeOverrideRemoved(outerHtml);
    if (!replacement) {
      throw Object.assign(
        new Error('No inline font-size override was found on this element — a font-size difference caused by a CSS class or stylesheet rule has no safe single-element fix.'),
        { status: 400, userFacing: true },
      );
    }
    return {
      content: { page, fixType, anchorHtml: outerHtml, replacement },
      summary: `Remove an inline font-size override on ${page}`,
    };
  }

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
  const a = fetched.analysis;

  if (fixType === 'malformed-table') {
    // First real match only — one bounded, reviewable change per draft, same
    // convention as schema-repair.js's duplicate-removal (one occurrence per
    // run, re-run to catch the rest). Only 'no-rows'/'empty-row' are ever
    // offered — a 'column-mismatch' entry (real, misaligned data) has no
    // safe removal fix and is deliberately excluded from removableMalformedTables.
    const target = (a.removableMalformedTables || [])[0];
    if (!target) throw Object.assign(new Error('No safely-removable broken table markup was found on this page — it may have changed since detection, or only have a column-mismatch issue, which needs manual review.'), { status: 400, userFacing: true });
    return {
      content: { page, fixType, reason: target.reason, anchorHtml: target.anchorHtml, replacement: '' },
      summary: `Remove ${target.reason === 'no-rows' ? 'an empty' : 'a broken (empty-row)'} table on ${page}`,
    };
  }

  if (fixType === 'raw-text-table') {
    const target = (a.rawTextTableBlocks || []).find((b) => b.clean);
    if (!target) {
      throw Object.assign(
        new Error('No cleanly-structured raw-text table was found on this page (real structure is required to rebuild it — a mixed/irregular block is left for manual review).'),
        { status: 400, userFacing: true },
      );
    }
    const site = await getSiteById(siteId).catch(() => null);
    const profile = site?.url_file_map?.siteRoot?.designProfile || null;
    const styles = projectTable(profile);
    const replacement = `<${target.tag}>${buildTableHtml(target.rows, styles)}</${target.tag}>`;
    return {
      content: { page, fixType, anchorHtml: target.anchorHtml, replacement, rows: target.rows },
      summary: `Convert raw-text comparison content into a real table on ${page}`,
    };
  }

  if (fixType === 'faq-schema-mismatch') {
    if (!a.faqSchemaRaw || !a.faqSchemaSimple) {
      throw Object.assign(
        new Error('The FAQPage schema on this page shares a <script> tag with other structured data — refusing to guess which part to rewrite.'),
        { status: 400, userFacing: true },
      );
    }
    if (!a.faqExtractionComplete) {
      throw Object.assign(
        new Error('Could not confidently extract the real answer text for every visible FAQ question on this page.'),
        { status: 400, userFacing: true },
      );
    }
    const jsonLd = buildFaqSchema(a.faqVisibleItems);
    return {
      content: { page, fixType, originalRaw: a.faqSchemaRaw, jsonLd },
      summary: `Resync FAQ schema with the ${a.faqVisibleItems.length} real visible FAQ question(s) on ${page}`,
    };
  }

  if (fixType === 'duplicate-faq') {
    if (!a.duplicateFaqRemovalHtml) {
      throw Object.assign(
        new Error('No confirmed-duplicate visible FAQ section was found on this page (two sections with substantially different real questions are never treated as a duplicate).'),
        { status: 400, userFacing: true },
      );
    }
    return {
      content: { page, fixType, anchorHtml: a.duplicateFaqRemovalHtml, replacement: '' },
      summary: `Remove a duplicate visible FAQ section on ${page}`,
    };
  }

  throw Object.assign(new Error(`Unknown content-integrity fixType "${fixType}".`), { status: 400 });
}
