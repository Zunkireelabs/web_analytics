// BOUNDED REPAIR of a change that failed design protection. A false failure must not permanently block a valid fix, and a real one must never ship, so a
// failing change gets a few honest attempts to use the site's OWN design (never an invented one) and is then re-checked by the same check that failed it.
// If it still fails it is quarantined by the caller with its content kept: this module never ships anything and never changes a threshold.
//
// What it can repair (all of them make the block MORE like the template, none adds design):
//   adoptSiteClasses   give each element the classes the template's own elements of that kind carry (or none, when the template's are plain), and
//                      remove classes the template never uses
//   fixHeadingLevels   demote a stray H1 and close skipped levels
//   wrapWideElements   put a table or <pre> in a horizontally scrolling box so it cannot push the page sideways on a phone
import * as cheerio from 'cheerio';
import { REPAIRABLE_KINDS } from './decide.js';

const KIND_TAGS = { h2: 'h2', h3: 'h3', p: 'p', ul: 'ul', ol: 'ol', table: 'table', blockquote: 'blockquote', a: 'a', details: 'details', summary: 'summary' };

/** Pure. Rewrites element classes to the baseline's observed ones. An element kind the baseline never observed is left exactly as it is. */
export function adoptSiteClasses(html, baseline) {
  const ec = baseline?.patterns?.elementClasses || baseline?.elementClasses;
  const vocab = new Set(baseline?.vocabulary || []);
  if (!ec && !vocab.size) return html;
  const $ = cheerio.load(`<div id="dp-root">${html}</div>`, null, false);
  $('#dp-root *').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (KIND_TAGS[tag] && ec && ec[tag] !== undefined) { const c = String(ec[tag] || '').trim(); if (c) $(el).attr('class', c); else $(el).removeAttr('class'); return; }
    const cls = String($(el).attr('class') || '').split(/\s+/).filter(Boolean);
    if (cls.length && vocab.size) { const keep = cls.filter((c) => vocab.has(c)); if (keep.length) $(el).attr('class', keep.join(' ')); else $(el).removeAttr('class'); }
  });
  // The site's own FAQ wrapper: the outer element that holds the question/answer items takes the classes the template's FAQ wrapper carries.
  const faq = baseline?.patterns?.faq;
  if (faq?.present && Array.isArray(faq.classes) && faq.classes.length) {
    $('#dp-root > section, #dp-root > div').filter((_, el) => $(el).find('details').length > 0).each((_, el) => { $(el).attr('class', faq.classes.join(' ')); });
  }
  // Inline styling is design the site did not choose: a block must use the template's classes, not its own look.
  $('#dp-root [style]').each((_, el) => { const s = String($(el).attr('style') || ''); if (/(font-|color|background|margin|padding|width|border)/i.test(s)) $(el).removeAttr('style'); });
  return $('#dp-root').html();
}

/** Pure. One H1 per page (the page already has it): any H1 in the block becomes an H2; a downward jump of more than one level is closed. */
export function fixHeadingLevels(html) {
  const $ = cheerio.load(`<div id="dp-root">${html}</div>`, null, false);
  const retag = (el, to) => { const $el = $(el); const inner = $el.html(); const attrs = el.attribs || {}; const n = $(`<${to}></${to}>`).attr(attrs).html(inner); $el.replaceWith(n); };
  $('#dp-root h1').each((_, el) => retag(el, 'h2'));
  let prev = 1; // the page's own H1 sits above the block
  $('#dp-root h2, #dp-root h3, #dp-root h4, #dp-root h5, #dp-root h6').each((_, el) => {
    const level = Number(el.tagName[1]);
    if (level > prev + 1) { retag(el, `h${prev + 1}`); prev += 1; } else prev = level;
  });
  return $('#dp-root').html();
}

/** Pure. A table or <pre> not already inside a scrolling box gets one, so it scrolls on a phone instead of widening the page. */
export function wrapWideElements(html) {
  const $ = cheerio.load(`<div id="dp-root">${html}</div>`, null, false);
  $('#dp-root table, #dp-root pre').each((_, el) => {
    const parent = $(el).parent();
    if (parent.attr('data-dp-scroll') !== undefined) return;
    $(el).wrap('<div data-dp-scroll style="overflow-x:auto;max-width:100%"></div>');
  });
  return $('#dp-root').html();
}

/** Pure. Which repairs apply to these deviations. */
export function repairsFor(deviations = []) {
  const kinds = new Set(deviations.map((d) => d.kind));
  const r = [];
  if (['foreign-classes', 'font-family', 'text-color', 'link-color', 'font-weight', 'heading-scale', 'body-size', 'line-height', 'table-text-size', 'faq-question-style', 'radius'].some((k) => kinds.has(k))) r.push('adoptSiteClasses');
  if (kinds.has('second-h1') || kinds.has('skipped-heading-level')) r.push('fixHeadingLevels');
  if (kinds.has('mobile-overflow')) r.push('wrapWideElements');
  return r;
}

export function applyRepairs(html, repairs, baseline) {
  let out = html;
  for (const name of repairs) {
    if (name === 'adoptSiteClasses') out = adoptSiteClasses(out, baseline);
    if (name === 'fixHeadingLevels') out = fixHeadingLevels(out);
    if (name === 'wrapWideElements') out = wrapWideElements(out);
  }
  return out;
}

/**
 * Re-checks after each repair with the SAME check that failed it. `check(html)` -> a decideProtection result (with .repairable and .reasons).
 * Stops at the first pass, when nothing is repairable, when a repair changes nothing, or after `maxAttempts`. Never ships; returns what happened.
 * @returns {{html:string, repaired:boolean, attempts:Array, final:object}}
 */
export async function repairLoop({ html, baseline, check, maxAttempts = 2, initial = null }) {
  // `initial` is the decision the caller already has for `html`: re-rendering the unrepaired block just to learn what is already known wastes a browser run.
  let current = html; let final = initial || await check(current); const attempts = [];
  for (let i = 0; i < maxAttempts && final.verdict === 'blocked' && final.repairable; i++) {
    const devs = final.reasons.map((r) => ({ kind: r.code }));
    if (!devs.every((d) => REPAIRABLE_KINDS.has(d.kind))) break;
    const repairs = repairsFor(devs);
    const next = applyRepairs(current, repairs, baseline);
    attempts.push({ attempt: i + 1, repairs, changed: next !== current, before: final.reasons.map((r) => r.code) });
    if (next === current) break;
    current = next; final = await check(current);
    attempts[attempts.length - 1].after = final.verdict === 'pass' ? ['pass'] : final.reasons.map((r) => r.code);
  }
  return { html: current, repaired: final.verdict === 'pass' && attempts.length > 0, attempts, final };
}
