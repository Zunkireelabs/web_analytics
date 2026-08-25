import { getFileContent, defaultBranchName } from '../../github/client.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { stripManagedMarkers } from '../../lib/managed-markers.js';
import { hasOrganicFaqSignal } from '../../lib/faq-signal.js';

// Finds a page's REAL, already-existing FAQ content grounded in the site's
// own repo — never LLM-fabricated — so a generator can use it verbatim
// instead of inventing new questions for a page that already answers them,
// and can refuse outright when real FAQ content exists but can't be safely
// read (rather than silently drafting a second, possibly mismatched one).
//
// Real incident, 2026-08-25: zunkireelabs.com's /resources/ page renders a
// genuine, hand-maintained FAQ ({% for item in faq %} over Eleventy's global
// src/_data/faq.json, 10 real Q&A pairs) — but faq.js had already drafted a
// completely different, LLM-fabricated FAQPage schema for that same page,
// because it only ever grounds in a flat bodyText excerpt and has no way to
// notice a page's *structured* real data. The two now visibly disagree.
//
// The template's own `{% for item in <var> %}` loop is the source of truth
// for what data backs a page's visible FAQ (Eleventy's convention: a global
// data file at src/_data/<var>.json is available in every template as
// `<var>`). Only .json is supported — a .js data file would need to be
// evaluated to read, which this deliberately does not do (arbitrary code
// execution risk from a client's own repo content).
const LOOP_PATTERN = /\{%\s*for\s+(\w+)\s+in\s+(\w*faq\w*)\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/i;

// Return contract:
//   { ok: true, items, dataFile }         — real Q&A pairs found, use verbatim, no LLM needed
//   { ok: false, organicSignal: true }    — this page already has real FAQ content the caller must not draft over
//   { ok: false, organicSignal: false }   — no real FAQ evidence found; safe for the caller's existing LLM path
//   null                                  — couldn't even check (no repo connected, no file mapping, fetch failed) —
//                                            a capability gap, not evidence either way; caller falls back unchanged
export async function findRealFaqDataSource(site, pageUrl) {
  if (!site?.repo_owner || !site?.repo_name) return null;
  const filePath = resolveFile(site, pageUrl);
  if (!filePath) return null;

  const file = await getFileContent(site, filePath, defaultBranchName(site)).catch(() => null);
  if (!file) return null;

  // Never match a loop that only exists inside this tool's own previously-
  // injected markup (e.g. qa-content.js's SEOAI:QACONTENT block can itself
  // render an accordion) — only genuinely organic template content counts,
  // for both the data-source match below and the organicSignal fallback.
  const organic = stripManagedMarkers(file.content);
  const organicSignal = hasOrganicFaqSignal(organic);

  const match = LOOP_PATTERN.exec(organic);
  if (!match) return { ok: false, organicSignal };

  const [, itemVar, dataVar, body] = match;
  // Confirm the loop body actually references question/answer fields on the
  // loop variable — otherwise `dataVar` just happens to have "faq" in its
  // name (e.g. a `faqCategories` nav list) without being real Q&A content.
  const questionRe = new RegExp(`${itemVar}\\.question`);
  const answerRe = new RegExp(`${itemVar}\\.answer`);
  if (!questionRe.test(body) || !answerRe.test(body)) return { ok: false, organicSignal };

  const dataFile = `src/_data/${dataVar}.json`;
  const dataFileContent = await getFileContent(site, dataFile, defaultBranchName(site)).catch(() => null);
  if (!dataFileContent) return { ok: false, organicSignal };

  let parsed;
  try {
    parsed = JSON.parse(dataFileContent.content);
  } catch {
    return { ok: false, organicSignal };
  }
  if (!Array.isArray(parsed)) return { ok: false, organicSignal };

  const items = parsed.filter((i) => i && typeof i.question === 'string' && i.question.trim() && typeof i.answer === 'string' && i.answer.trim());
  if (items.length < 2) return { ok: false, organicSignal };

  return { ok: true, items: items.map((i) => ({ question: i.question.trim(), answer: i.answer.trim() })), dataFile };
}
