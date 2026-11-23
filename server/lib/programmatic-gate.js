// The pre-publish quality gate for pages made in bulk from one template (a page per city, per service, per product). Google's
// scaled-content-abuse policy targets exactly this: many pages whose only difference is a swapped name. Nothing here writes or blocks
// anything by itself; it returns a verdict, per page and for the batch, that the caller (the shipping step) acts on.
//
// The size rules follow claude-seo's seo-programmatic skill (MIT, (c) 2026 agricidaniel): thin under 300 words; 100+ pages without a
// content review is a warning, 500+ without explicit approval is a hard stop; roll out in batches of 50-100.
// The uniqueness measure and its cut-offs are NOT the skill's. It measures "words unique to this page" and warns under 40%, stops under
// 30%; but a genuinely different page still reuses most of its individual words ("the", "plumber", "service"), so a per-word measure
// cannot tell the two apart. This measures unique 4-WORD PHRASES instead, and because that is a different scale the cut-offs were
// recalibrated on realistic pages rather than copied. Measured (the share of a page's phrases found on no other page of the family):
//   a template with only the name swapped        10-35%   (the denser the swapped name, the higher)
//   75% template + 25% original sections          34%
//   50% template + 50% original sections          56%
//   25% template + 75% original sections          62%
//   genuinely different pages                     80% and up
// so: under 40% is mostly template (stop), under 60% is half-and-half (warn), and 60% and up passes.
// Pure: text in, verdicts out.

export const THRESHOLDS = Object.freeze({
  THIN_WORDS: 300,
  UNIQUE_WARN: 0.60,
  UNIQUE_BLOCK: 0.40,
  REVIEW_AT: 100,      // this many pages in one family without a human review: warn
  HARD_STOP_AT: 500,   // this many without explicit approval: block
  BATCH_MAX: 100,      // recommended largest single rollout
  PHRASE_WORDS: 4,
});

const words = (text) => String(text || '').toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}']+/gu, ' ').trim().split(' ').filter(Boolean);

export function phrases(text, size = THRESHOLDS.PHRASE_WORDS) {
  const w = words(text);
  if (w.length === 0) return new Set();
  if (w.length <= size) return new Set([w.join(' ')]);
  const out = new Set();
  for (let i = 0; i <= w.length - size; i += 1) out.add(w.slice(i, i + size).join(' '));
  return out;
}

const SEVERITY = { pass: 0, warn: 1, block: 2 };
const worst = (a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a);

/**
 * @param pages            [{ id, text }]  the batch about to ship (body text only: shared header, footer and navigation excluded)
 * @param against          [{ id, text }]  pages of the same family that already exist; compared against, never judged
 * @param alreadyPublished how many pages of this family are already live (counts toward the batch-size limits)
 * @param reviewed         a person has reviewed a sample of this family's pages
 * @param approvedLarge    a person explicitly approved a family of 500+ pages
 * @returns { verdict, reasons, batch: { size, family }, pages: [{ id, words, uniquePct, verdict, flags }] }
 */
export function evaluateProgrammaticBatch({ pages = [], against = [], alreadyPublished = 0, reviewed = false, approvedLarge = false } = {}) {
  const sets = pages.map((p) => phrases(p.text));
  const againstSets = against.map((p) => phrases(p.text));
  const count = new Map();
  for (const s of [...sets, ...againstSets]) for (const ph of s) count.set(ph, (count.get(ph) || 0) + 1);

  const compared = pages.length + against.length > 1;
  const results = pages.map((p, i) => {
    const wordCount = words(p.text).length;
    const flags = [];
    let verdict = 'pass';
    // A phrase is unique when it appears on no other page of the family (the page's own copy is the 1).
    const uniquePct = compared && sets[i].size ? [...sets[i]].filter((ph) => count.get(ph) === 1).length / sets[i].size : null;
    if (wordCount < THRESHOLDS.THIN_WORDS) { flags.push('thin'); verdict = worst(verdict, 'warn'); }
    if (uniquePct !== null && uniquePct < THRESHOLDS.UNIQUE_BLOCK) { flags.push('mostly-template'); verdict = worst(verdict, 'block'); }
    else if (uniquePct !== null && uniquePct < THRESHOLDS.UNIQUE_WARN) { flags.push('low-unique'); verdict = worst(verdict, 'warn'); }
    return { id: p.id, words: wordCount, uniquePct: uniquePct === null ? null : Math.round(uniquePct * 100) / 100, verdict, flags };
  });

  let verdict = results.reduce((v, r) => worst(v, r.verdict), 'pass');
  const reasons = [];
  const family = alreadyPublished + pages.length;
  if (family >= THRESHOLDS.HARD_STOP_AT && !approvedLarge) {
    verdict = 'block'; reasons.push(`${family} pages in this family and no explicit approval: hard stop at ${THRESHOLDS.HARD_STOP_AT}`);
  } else if (family >= THRESHOLDS.REVIEW_AT && !reviewed) {
    verdict = worst(verdict, 'warn'); reasons.push(`${family} pages in this family without a content review: review a sample before publishing more`);
  }
  if (pages.length > THRESHOLDS.BATCH_MAX) { verdict = worst(verdict, 'warn'); reasons.push(`${pages.length} pages in one rollout: publish in batches of ${THRESHOLDS.BATCH_MAX} or fewer and watch indexing before the next`); }
  const blocked = results.filter((r) => r.verdict === 'block').length;
  const low = results.filter((r) => r.flags.includes('low-unique')).length;
  const thin = results.filter((r) => r.flags.includes('thin')).length;
  if (blocked) reasons.push(`${blocked} page${blocked === 1 ? ' is' : 's are'} mostly the shared template (under ${THRESHOLDS.UNIQUE_BLOCK * 100}% unique)`);
  if (low) reasons.push(`${low} page${low === 1 ? ' has' : 's have'} low unique content (under ${THRESHOLDS.UNIQUE_WARN * 100}%)`);
  if (thin) reasons.push(`${thin} page${thin === 1 ? ' is' : 's are'} under ${THRESHOLDS.THIN_WORDS} words`);
  return { verdict, reasons, batch: { size: pages.length, family }, pages: results };
}
