// Pure comparison of an inserted block (and the page around it) against the TEMPLATE BASELINE. No browser, no network, no database.
//
// Principles:
//  - The yardstick is the template's own captured baseline at the same viewport, never an absolute and never another client's values.
//  - The numeric tolerances are the SAME ones the existing render gate uses (body-measure.js TOLERANCES): this layer adds checks the old one lacked
//    (family, colour, weight, container width, radius, foreign classes, outside-unchanged, heading hierarchy); it does not loosen the ones it had.
//  - Every deviation says what was expected and what was found, so a person (and the repair step) can act on it.
import { TOLERANCES } from '../../design-agent/live-analysis/body-measure.js';

const off = (a, b, tol) => (a > 0 && b > 0 ? Math.abs(b - a) / a > tol : false);
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/** Pure. Deviations of the block from the baseline tokens measured at `viewport` ('desktop' | 'mobile'). */
export function compareBlockToBaseline(block, baseline, viewport, tol = TOLERANCES) {
  const out = [];
  if (!block?.found || !baseline) return out;
  const t = baseline.tokens?.[viewport];
  if (!t) return out;
  const add = (kind, expected, actual) => out.push({ kind, expected, actual, viewport });

  const bt = block.text; const ref = t.p;
  if (bt && ref) {
    if (ref.family && bt.family && norm(ref.family) !== norm(bt.family)) add('font-family', ref.family, bt.family);
    if (off(ref.fontSize, bt.fontSize, tol.pFontSize)) add('body-size', ref.fontSize, bt.fontSize);
    if (off(ref.lineHeightRatio, bt.lineHeightRatio, tol.lineHeight)) add('line-height', ref.lineHeightRatio, bt.lineHeightRatio);
    if (ref.fontWeight && bt.fontWeight && String(ref.fontWeight) !== String(bt.fontWeight)) add('font-weight', ref.fontWeight, bt.fontWeight);
    if (ref.color && bt.color && norm(ref.color) !== norm(bt.color)) add('text-color', ref.color, bt.color);
  }
  for (const level of ['h2', 'h3']) {
    const bh = block.headings?.[level]; const rh = t[level];
    if (!bh || !rh) continue;
    if (off(rh.fontSize, bh.fontSize, tol.h2FontSize)) add('heading-scale', `${level} ${rh.fontSize}`, `${level} ${bh.fontSize}`);
    if (rh.family && bh.family && norm(rh.family) !== norm(bh.family)) add('font-family', `${level} ${rh.family}`, `${level} ${bh.family}`);
    if (rh.color && bh.color && norm(rh.color) !== norm(bh.color)) add('text-color', `${level} ${rh.color}`, `${level} ${bh.color}`);
    if (rh.fontWeight && bh.fontWeight && String(rh.fontWeight) !== String(bh.fontWeight)) add('font-weight', `${level} ${rh.fontWeight}`, `${level} ${bh.fontWeight}`);
  }
  // A FAQ question is judged against the template's OWN question style (its <summary>), never against body prose: a site's questions are legitimately bolder.
  const qs = baseline.patterns?.faq?.questionStyle;
  if (block.question && qs) {
    if (qs.family && block.question.family && norm(qs.family) !== norm(block.question.family)) add('faq-question-style', `question font ${qs.family}`, block.question.family);
    if (off(qs.fontSize, block.question.fontSize, tol.pFontSize)) add('faq-question-style', `question size ${qs.fontSize}`, block.question.fontSize);
    if (qs.fontWeight && String(qs.fontWeight) !== String(block.question.fontWeight)) add('faq-question-style', `question weight ${qs.fontWeight}`, block.question.fontWeight);
    if (qs.color && norm(qs.color) !== norm(block.question.color)) add('faq-question-style', `question colour ${qs.color}`, block.question.color);
  }
  if (block.link && t.link?.color && norm(block.link.color) !== norm(t.link.color)) add('link-color', t.link.color, block.link.color);
  // The block must not be wider than the template's own body column (2px slack for rounding).
  if (t.containerWidth && block.maxWidth > t.containerWidth + 2) add('container-width', t.containerWidth, block.maxWidth);
  // Radii the template does not use anywhere in its body: a new rounded card style.
  const known = new Set((t.radii || []).map(Number));
  for (const r of block.radii || []) if (![...known].some((k) => Math.abs(k - r) <= 1)) { add('radius', [...known].join(',') || 'none', r); break; }
  // Classes the template's body never uses: the block extends the design instead of using it. (Vocabulary is the baseline's, per template.)
  if (Array.isArray(baseline.vocabulary) && baseline.vocabulary.length) {
    const vocab = new Set(baseline.vocabulary);
    const foreign = (block.classes || []).filter((c) => !vocab.has(c));
    if (foreign.length) add('foreign-classes', 'classes the template already uses', foreign.slice(0, 8).join(' '));
  }
  if (block.table && baseline.patterns?.table?.present && baseline.patterns.table.cellFontSize
    && off(baseline.patterns.table.cellFontSize, block.table.cellFontSize, 0.12)) add('table-text-size', baseline.patterns.table.cellFontSize, block.table.cellFontSize);
  if (viewport === 'mobile' && block.overflowing?.length) add('mobile-overflow', 'inside the screen width', block.overflowing.join(', '));
  return out;
}

/** Pure. Differences in what is OUTSIDE the changed zone, before vs after. Same length and same signature per element is "unchanged". */
export function compareOutside(before, after, { max = 5 } = {}) {
  if (!before || !after) return [];
  const diffs = [];
  if (before.count !== after.count) diffs.push({ kind: 'outside-changed', detail: `${before.count} elements outside the change before, ${after.count} after` });
  const n = Math.min(before.sig.length, after.sig.length);
  for (let i = 0; i < n && diffs.length < max; i++) {
    if (before.sig[i] !== after.sig[i]) diffs.push({ kind: 'outside-changed', detail: `element #${i}: ${before.sig[i].split('|').slice(0, 3).join(' ')} changed` });
  }
  return diffs;
}

/** Pure. Heading problems the change introduced (a pre-existing one is not blamed on it). */
export function headingIssues(beforeLevels = [], afterLevels = [], block = null) {
  const out = [];
  const count = (a, l) => a.filter((x) => x === l).length;
  if (count(afterLevels, 1) > count(beforeLevels, 1) || (block?.h1Count || 0) > 0) out.push({ kind: 'second-h1', detail: 'the change adds an H1; a page has one' });
  const jumps = (a) => { let n = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[i - 1] + 1) n++; return n; };
  if (jumps(afterLevels) > jumps(beforeLevels)) out.push({ kind: 'skipped-heading-level', detail: 'the change skips a heading level (for example H2 straight to H4)' });
  return out;
}

/** Pure. A mobile overflow the change caused (the page was fine before). */
export function overflowRegression(beforeOverflow, afterOverflow) {
  return afterOverflow && !beforeOverflow ? [{ kind: 'mobile-overflow', detail: 'the page scrolls sideways after the change and did not before' }] : [];
}

/** One readable sentence for a deviation list, for the draft's error and the person reading it. */
export function describeDeviations(devs = []) {
  return devs.slice(0, 6).map((d) => (d.detail ? `${d.kind}: ${d.detail}` : `${d.kind} ${d.expected} → ${d.actual} (${d.viewport})`)).join('; ');
}
