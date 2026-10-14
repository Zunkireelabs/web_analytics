import { analyzePageUrl, fetchHtml, inferSchemaType, rebuildFaqContainerText } from '../agents/lib/page-content.js';
import { buildFontSizeOverrideRemoved, buildScopedFontSizeFix } from '../agents/lib/font-consistency-analysis.js';
import { getSiteById } from '../store/read.js';
import { projectTable } from '../design-agent/lib/design-profile.js';
import { buildTableHtml, escapeHtml } from './lib/markdown-table-render.js';
import { generateFaqItemsFromEvidence, PAGE_PURPOSE_GUIDANCE } from './faq.js';
import { pageStructureGuidance } from './lib/design-aware-composer.js';

// Repairs the defect shapes content-integrity.js/font-consistency.js
// detect — broken/empty table markup, comparison content shipped as raw
// delimited text instead of a real <table>, an FAQPage schema whose question
// count has drifted from the real visible FAQ content, a confirmed-duplicate
// visible FAQ section, an FAQ whose visible questions don't match the page's
// own topic, the same FAQ question answered inconsistently across pages, and
// a one-element inline font-size override that diverges from the rest of the
// site — using ONLY real facts already,
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
  description: 'Removes broken/empty table markup, rebuilds comparison content shipped as raw text into a real table, resyncs FAQ schema with the real visible FAQ content, removes a confirmed-duplicate visible FAQ section, and matches a drifted table/heading/body section\'s classes to the site\'s own real design convention.',
  recommendationTags: [],
};

// Real class-string equality, ignoring order/whitespace — how "the anchor's
// class attribute still matches what detection observed" is checked below,
// same tokenization consistency-check.js itself uses (classTokens there).
function tokenSet(classString) {
  return new Set((classString || '').trim().split(/\s+/).filter(Boolean));
}

function sameTokens(a, b) {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// Swaps ONLY the class attribute's value inside anchorHtml's OPENING tag —
// every other byte (attribute order, quote style, inner content,
// self-closing form) stays untouched. Deliberately a surgical string
// substitution rather than a full HTML parse + reserialize: cheerio (or any
// HTML parser) round-tripping a <table> can silently insert a missing
// <tbody> or otherwise restructure it, which would make `replacement` not
// what the live page actually has — the exact class of bug this whole
// exact-anchor discipline exists to prevent.
//
// Returns null (never guesses) when the opening tag has no class attribute,
// or when its current value doesn't token-match `expectedClasses` — either
// means the live anchor and the evidence captured at detection time have
// drifted apart since the scan ran, same "may have changed since detection"
// refusal every other fixType below already gives.
function swapAnchorClass(anchorHtml, expectedClasses, newClasses) {
  const tagMatch = typeof anchorHtml === 'string' ? anchorHtml.match(/^<[a-zA-Z][\w-]*\b[^>]*>/) : null;
  if (!tagMatch) return null;
  const openingTag = tagMatch[0];
  const classMatch = openingTag.match(/\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/);
  if (!classMatch) return null;
  const currentValue = classMatch[1] !== undefined ? classMatch[1] : classMatch[2];
  if (!sameTokens(tokenSet(currentValue), tokenSet(expectedClasses))) return null;
  const quote = classMatch[0].includes('"') ? '"' : "'";
  const newOpeningTag = openingTag.slice(0, classMatch.index) + `class=${quote}${newClasses}${quote}` + openingTag.slice(classMatch.index + classMatch[0].length);
  return newOpeningTag + anchorHtml.slice(openingTag.length);
}

// Deterministic transform of rows ALREADY extracted verbatim from the raw
// text (page-content.js's parsePipeRow) — first row is the header, same
// convention as the markdown-table shape this content came from.
//
// buildTableHtml now lives in generators/lib/markdown-table-render.js —
// shared with newpage-render.js's projectMarkdownTablesInBody so a table
// repaired here and a table inside a freshly generated blog post go through
// the exact same rendering call, not two implementations that can drift.

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

// params: { page: string, fixType: 'malformed-table'|'raw-text-table'|'faq-schema-mismatch'|'duplicate-faq'|'faq-topic-mismatch'|'faq-cross-page-inconsistency'|'font-size-override'|'table-style-drift'|'typography-drift'|'typography-drift-scoped' }
// 'faq-cross-page-inconsistency' additionally requires params.question and params.correctAnswer.
export async function generate({ siteId, params }) {
  const { page, fixType } = params || {};
  if (!page || !fixType) throw Object.assign(new Error('page and fixType are required'), { status: 400 });

  // table-style-drift / typography-drift: routed from
  // agents/lib/design-consistency.js's whole-page scan (consistency-check.js)
  // — a section's classes share zero tokens with this site's OWN observed
  // convention for that component. Grounded the same way font-size-override
  // above is: a live Playwright DOM capture's outerHTML as the anchor, not a
  // second static fetch, for the same hydration reason. `sectionClasses` is
  // what detection found on the anchor; `siteConvention` is the real class
  // string already observed elsewhere on this site (design-profile.js) —
  // never invented, never generated by an LLM.
  if (fixType === 'table-style-drift' || fixType === 'typography-drift') {
    const { sectionClasses, siteConvention, outerHtml } = params;
    if (!outerHtml) {
      throw Object.assign(new Error('No live-captured section markup was recorded for this finding — it cannot be safely patched.'), { status: 400, userFacing: true });
    }
    if (!siteConvention) {
      throw Object.assign(new Error('No real site design convention is available to match this section to.'), { status: 400, userFacing: true });
    }
    const replacement = swapAnchorClass(outerHtml, sectionClasses, siteConvention);
    if (!replacement) {
      throw Object.assign(
        new Error('The live section markup no longer matches what design-consistency detected — it may have changed since the scan ran.'),
        { status: 400, userFacing: true },
      );
    }
    return {
      content: { page, fixType, anchorHtml: outerHtml, replacement },
      summary: fixType === 'table-style-drift'
        ? `Match this table's styling to the site's own design convention on ${page}`
        : `Match this section's typography to the site's own design convention on ${page}`,
    };
  }

  // typography-drift-scoped: the outlier element carries NO class of its own
  // (styled purely via an ancestor wrapper + tag selector, e.g. Chayce's
  // ".hiw-hero h1") — font-consistency.js's own live-capture evidence already
  // confirmed that exact ancestor class is not used by ANY other sampled
  // page in the same run, so a declaration scoped to ".{ancestorClass}
  // {tag}" can only ever affect this one page's own heading, never a shared
  // component. Distinct from 'typography-drift' above (which swaps a CLASS
  // value on the element itself): there is no class to swap here, so the fix
  // instead targets the real CSS declaration text embedded directly on the
  // page. Re-fetches and re-derives the fix from scratch (never trusts a
  // value computed at detection time) — the same "may have changed since
  // detection" refusal buildScopedFontSizeFix itself gives when the
  // declaration is no longer uniquely findable, already correct, or has
  // become a fluid expression this platform won't flatten.
  if (fixType === 'typography-drift-scoped') {
    const { ancestorClass, tag, expectedFontSize } = params;
    if (!ancestorClass || !tag || !expectedFontSize) {
      throw Object.assign(new Error('ancestorClass, tag, and expectedFontSize are all required for fixType "typography-drift-scoped"'), { status: 400 });
    }
    const fetched = await fetchHtml(page);
    if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
    const fix = buildScopedFontSizeFix(fetched.html, ancestorClass, tag, expectedFontSize);
    if (!fix) {
      throw Object.assign(
        new Error(`Could not find exactly one plain-length font-size declaration for ".${ancestorClass} ${tag}" on this page — it may have changed since detection, stopped being unique, or become a responsive expression.`),
        { status: 400, userFacing: true },
      );
    }
    return {
      content: { page, fixType, anchorHtml: fix.anchorHtml, replacement: fix.replacement },
      summary: `Correct this page's own heading size to match ${expectedFontSize} on ${page}`,
    };
  }

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
    const tableHtml = buildTableHtml(target.rows, styles);
    // A real lead-in/trailing sentence sharing the block with the table
    // (e.g. "...here's a breakdown: | Feature | ...") is kept, verbatim, as
    // its own element around the new <table> rather than discarded — only
    // the actual pipe-text rows are being converted here.
    const replacement = target.beforeText || target.afterText
      ? [
          target.beforeText ? `<${target.tag}>${escapeHtml(target.beforeText)}</${target.tag}>` : '',
          tableHtml,
          target.afterText ? `<${target.tag}>${escapeHtml(target.afterText)}</${target.tag}>` : '',
        ].filter(Boolean).join('')
      : `<${target.tag}>${tableHtml}</${target.tag}>`;
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

  // faq-topic-mismatch: content-integrity.js's findTopicallyMismatchedFaq
  // already confirmed (via its own independent, self-consistency-checked LLM
  // pass) that this page's visible FAQ questions are about a DIFFERENT topic
  // than the page itself (the zunkireelabs.com/careers/ incident this whole
  // check exists for — product-feature FAQs on a careers page). The fix
  // regenerates the FAQ CONTENT using the exact same real-evidence-grounded
  // generation generators/faq.js already uses for a net-new FAQ (page body
  // text, the page's own real title as the subject, PAGE_PURPOSE_GUIDANCE for
  // its inferred schema type) — never a second, bespoke FAQ-writing prompt —
  // then places the new text back into the EXACT SAME markup structure the
  // page already has (rebuildFaqContainerText only ever swaps text nodes,
  // never classes/tags), so the page's own design is untouched. Only offered
  // when every existing question's real answer was confidently extracted
  // (faqExtractionComplete) and the page has exactly one unambiguous FAQ
  // container (faqContainerHtml) — a page failing either bar still shows up
  // in the finding, just without a one-click fix, same convention as every
  // other narrow auto-fix in this file.
  //
  // No visible_faq_cap check here: this NEVER adds a new visible FAQ to a
  // page — the page already has one (that's the only way faqExtractionComplete
  // and faqContainerHtml could both be true) — it only corrects the words of
  // an already-visible, already-cap-counted section. implementers/lib/
  // faq-render-mode.js's cap logic governs whether a page gets a FIRST
  // visible FAQ at all; it has nothing to decide here, and re-deriving it
  // would just be a second, driftable copy of that same enforcement.
  if (fixType === 'faq-topic-mismatch') {
    if (!a.faqExtractionComplete) {
      throw Object.assign(
        new Error('Could not confidently extract the real answer text for every visible FAQ question on this page — regenerating it safely requires knowing what every question currently answers.'),
        { status: 400, userFacing: true },
      );
    }
    if (!a.faqContainerHtml) {
      throw Object.assign(
        new Error('This page\'s FAQ isn\'t wrapped in one single, unambiguous container (or has more than one) — regenerating its content in place isn\'t safe to do automatically.'),
        { status: 400, userFacing: true },
      );
    }
    const site = await getSiteById(siteId).catch(() => null);
    const schemaType = inferSchemaType(page, a.schemaTypes, a);
    const pageGuidance = schemaType ? PAGE_PURPOSE_GUIDANCE[schemaType] : null;
    const structureGuidance = pageStructureGuidance(site, 'faq');
    const bodyExcerpt = a.bodyText ? a.bodyText.slice(0, 3000) : null;
    const newItems = await generateFaqItemsFromEvidence({
      siteId, subject: a.title || page, bodyExcerpt, pageGuidance, structureGuidance,
      expectedCount: a.faqVisibleItems.length,
    });
    const replacement = rebuildFaqContainerText(a.faqContainerHtml, newItems);
    if (!replacement) {
      throw Object.assign(
        new Error('The regenerated FAQ content could not be safely placed back into this page\'s exact existing markup (a wrong item count from the model, or a question/answer element with nested markup this app won\'t overwrite) — left for manual review.'),
        { status: 400, userFacing: true },
      );
    }
    const content = { page, fixType, anchorHtml: a.faqContainerHtml, replacement };
    // Resync the FAQPage schema in the SAME draft, same bar as the
    // faq-schema-mismatch fix above — otherwise the visible text would be
    // corrected while the schema still describes the old, mismatched
    // questions, a drift faqCountMismatch's own count-only comparison can
    // never catch (see page-content.js's faqCountMismatch comment).
    if (a.faqSchemaRaw && a.faqSchemaSimple) {
      content.schemaOriginalRaw = a.faqSchemaRaw;
      content.jsonLd = buildFaqSchema(newItems);
    }
    return { content, summary: `Rewrite ${newItems.length} FAQ item(s) on ${page} to match this page's own topic` };
  }

  // faq-cross-page-inconsistency: content-integrity.js's
  // findInconsistentFaqQuestions found the SAME real question answered
  // differently on 2+ pages checked this run, and the agent's own evidence-
  // based decision (decideCrossPageFaqAnswer, content-integrity.js) already
  // picked which page's answer is wrong and what the correct real answer
  // text is (copied verbatim from the other, more-trustworthy page — never
  // LLM-invented). This fix only ever replaces that ONE answer's text, in
  // place, on the losing page — same narrow, exact-anchor discipline as
  // every other fix here, and never touches the question text (identical on
  // both pages by definition) or any other Q&A pair on the page.
  if (fixType === 'faq-cross-page-inconsistency') {
    const { question, correctAnswer } = params;
    if (!question || !correctAnswer) throw Object.assign(new Error('question and correctAnswer are required for fixType "faq-cross-page-inconsistency"'), { status: 400 });
    if (!a.faqExtractionComplete) {
      throw Object.assign(
        new Error('Could not confidently extract the real answer text for every visible FAQ question on this page — correcting just one answer in place still requires knowing every current answer.'),
        { status: 400, userFacing: true },
      );
    }
    if (!a.faqContainerHtml) {
      throw Object.assign(
        new Error('This page\'s FAQ isn\'t wrapped in one single, unambiguous container — correcting just this answer in place isn\'t safe to do automatically.'),
        { status: 400, userFacing: true },
      );
    }
    const normalizedTarget = question.toLowerCase().replace(/\s+/g, ' ').trim();
    const match = a.faqVisibleItems.find((item) => item.question.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedTarget);
    if (!match) {
      throw Object.assign(
        new Error('That question is no longer visible on this page — it may have changed since detection.'),
        { status: 400, userFacing: true },
      );
    }
    if (match.answer.trim() === correctAnswer.trim()) {
      throw Object.assign(new Error('This page\'s answer already matches the correct text — nothing to fix.'), { status: 400, userFacing: true });
    }
    const newItems = a.faqVisibleItems.map((item) => (
      item.question.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedTarget
        ? { question: item.question, answer: correctAnswer }
        : item
    ));
    const replacement = rebuildFaqContainerText(a.faqContainerHtml, newItems);
    if (!replacement) {
      throw Object.assign(
        new Error('This page\'s FAQ markup shape doesn\'t support a safe in-place text correction — left for manual review.'),
        { status: 400, userFacing: true },
      );
    }
    const content = { page, fixType, anchorHtml: a.faqContainerHtml, replacement };
    if (a.faqSchemaRaw && a.faqSchemaSimple) {
      content.schemaOriginalRaw = a.faqSchemaRaw;
      content.jsonLd = buildFaqSchema(newItems);
    }
    return { content, summary: `Correct one inconsistent FAQ answer on ${page} to match its more authoritative page` };
  }

  throw Object.assign(new Error(`Unknown content-integrity fixType "${fixType}".`), { status: 400 });
}
