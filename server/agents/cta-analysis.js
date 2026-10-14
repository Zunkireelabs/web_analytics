import * as cheerio from 'cheerio';
import { getSiteById } from '../store/read.js';
import { siteOriginFor } from './lib/site-domain.js';
import { fetchHtml, isPrivateOrLocalHost } from './lib/page-content.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';
import { VERDICT, makeVerification } from './lib/verdict.js';

// Conversion/CTA analysis (Product Growth spec §3) — generic across any
// site, Product or Website: finds the primary conversion call-to-action on
// the homepage and checks it actually points somewhere real. No
// requiresCapabilities — homepage HTML is available to any onboarded site.
//
// Origin: the exact real bug this generalizes — Zenly's homepage "Book a
// Demo" links all resolved to a `mailto:` address instead of the working
// /demo form that existed and was linked elsewhere. That is one instance of
// a broader, evidence-checkable class ("the button real visitors click
// doesn't go anywhere real"), not something specific to demo CTAs or to
// Zenly, so the check below is pattern-based, not name-based.
export const meta = {
  id: 'cta-analysis',
  name: 'CTA Analysis Agent',
  description: 'Checks whether this site\'s real primary conversion CTAs actually reach a working page, instead of a dead link or a mailto: fallback.',
  category: 'on-page',
  requiresCapabilities: ['public-web'],
  version: 1,
};

// Deliberately broad, not funnel-specific — "book a demo" and "start free
// trial" and "get a quote" are all the same underlying pattern (a visitor
// clicking their way toward the site's own configured conversion event,
// whatever that is — see product_growth_config.conversion_event).
const CTA_TEXT_PATTERN = /\b(book|schedule|request|get)\b.{0,15}\b(demo|call|quote|consultation)\b|\bstart\b.{0,15}\btrial\b|\bsign\s?up\b|\bget\s?started\b|\bcontact\s?(us|sales)\b/i;

// Attributes that mean "script handles this click" — a '#'/empty anchor or a
// bare <button> carrying one is wired up at runtime, not a dead end.
const HANDLER_ATTR_RE = /^(on[a-z]+|@.+|x-on.*|v-on.*|hx-.+|data-(toggle|target|action|modal|bs-.+|trigger|open|href|url|link)|aria-(controls|haspopup|expanded))$/i;
function hasClickHandler($el) {
  const attrs = Object.keys($el.get(0)?.attribs || {});
  return attrs.some((a) => HANDLER_ATTR_RE.test(a)) || ($el.attr('role') || '').toLowerCase() === 'button';
}

// Only <a href> is a navigation CTA. A <button> is evaluated only when it has
// no href, no inline/framework handler, no id (script can bind by id), no
// enclosing <a>/<form> and isn't type=submit — and even then its verdict is
// unverifiable below, since a listener attached by script is invisible to a
// static fetch.
export function extractCtaCandidates(html) {
  const $ = cheerio.load(html);
  const ctaCandidates = [];
  $('a[href]').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text || !CTA_TEXT_PATTERN.test(text)) return;
    const href = $(el).attr('href') || '';
    // '#'/empty href with a click handler is a JS-driven control (modal/menu).
    if ((href === '#' || href.trim() === '' || /^javascript:/i.test(href)) && hasClickHandler($(el))) return;
    ctaCandidates.push({ text, href, kind: 'link' });
  });
  $('button').each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text || !CTA_TEXT_PATTERN.test(text)) return;
    if ($el.closest('a[href]').length || $el.closest('form').length) return; // the anchor/form carries the destination
    if (($el.attr('type') || '').toLowerCase() === 'submit' || $el.attr('form') || $el.attr('formaction')) return;
    if ($el.attr('id') || hasClickHandler($el)) return;
    ctaCandidates.push({ text, href: null, kind: 'button' });
  });
  return ctaCandidates;
}

// 'confirmed' only for a definite defect; anything that merely failed to
// answer a bare fetch (403/429/5xx/timeouts, bot-blocked external CTAs) is
// 'unverifiable' — never asserted as "did not load".
export async function checkDestination(href, origin, fetchPage = fetchHtml) {
  if (href == null) {
    return { ok: false, verdict: VERDICT.UNVERIFIABLE, reason: 'is a <button> with no link, no inline handler and no form — a script-bound listener cannot be ruled out from static HTML.' };
  }
  if (href === '#' || href.trim() === '') {
    return { ok: false, verdict: VERDICT.CONFIRMED, reason: 'empty or "#" href with no click handler — goes nowhere.' };
  }
  // mailto:/tel: are real, legitimate destinations — never a defect.
  if (/^(mailto|tel|sms):/i.test(href.trim())) return { ok: true, reason: null };

  let absolute;
  try { absolute = new URL(href, origin).href; } catch { return { ok: false, verdict: VERDICT.CONFIRMED, reason: `"${href}" is not a resolvable URL.` }; }
  if (!/^https?:/i.test(absolute)) return { ok: true, reason: null }; // javascript:/other schemes — not a fetchable page claim

  const hostname = new URL(absolute).hostname;
  if (isPrivateOrLocalHost(hostname)) return { ok: false, verdict: VERDICT.CONFIRMED, reason: `"${href}" resolves to a private/local address.` };

  const fetched = await fetchPage(absolute);
  if (fetched.ok) return { ok: true, reason: null };
  if (fetched.error === 'not HTML') return { ok: true, reason: null }; // a PDF/file download is a real destination
  if (fetched.error === 'not found') return { ok: false, verdict: VERDICT.CONFIRMED, reason: `"${absolute}" did not load (not found).` };
  return {
    ok: false, verdict: VERDICT.UNVERIFIABLE,
    reason: `"${absolute}" could not be checked (${fetched.error}) — it may be blocking automated requests while working for real visitors.`,
  };
}

export async function run({ siteId }) {
  const site = await getSiteById(siteId);
  const origin = siteOriginFor(site);
  if (!origin) {
    return { meta, status: 'insufficient-data', facts: null, narrative: null, message: 'No known site domain to check CTAs against.', generatedAt: new Date().toISOString() };
  }

  const homepage = await fetchHtml(origin);
  if (!homepage.ok) {
    return { meta, status: 'insufficient-data', facts: null, narrative: null, message: `Could not fetch the homepage (${homepage.error}).`, generatedAt: new Date().toISOString() };
  }

  const ctaCandidates = extractCtaCandidates(homepage.html);

  if (!ctaCandidates.length) {
    return {
      meta, status: 'ok',
      facts: { origin, ctaCandidates: [], findings: [] },
      narrative: null, generatedAt: new Date().toISOString(),
    };
  }

  const checked = [];
  for (const c of ctaCandidates) {
    const result = await checkDestination(c.href, origin);
    checked.push({ ...c, ...result });
  }

  const broken = checked.filter((c) => !c.ok);
  const priorities = priorityByRank(broken);
  const findings = broken.map((c, i) => makeFinding({
    id: `cta-analysis:${c.text}:${c.href || 'empty'}`,
    evidence: { ctaText: c.text, href: c.href, reason: c.reason },
    whyItMatters: c.verdict === VERDICT.CONFIRMED
      ? `The "${c.text}" call-to-action on the homepage ${c.reason} A real visitor clicking this never reaches a working page.`
      : `The "${c.text}" call-to-action on the homepage ${c.reason}`,
    verification: makeVerification(c.verdict, c.kind === 'button' ? 'static-html-button' : 'http-probe', c.reason),
    priority: priorities[i],
    recommendedAction: null, // the real fix (correct href, working destination page) is a manual content/dev decision, not something safe to auto-generate
    expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'estimate' },
    reportOnly: {
      kind: 'broken-primary-cta',
      label: `"${c.text}" CTA doesn't reach a working page`,
      page: '/',
      whyBlocked: `${c.reason} Fixing this requires knowing the real intended destination — not something safe to guess automatically.`,
    },
  }));

  const facts = { origin, ctaCandidates: checked.map(({ text, href, ok, reason, verdict }) => ({ text, href, ok, reason, verdict: verdict || null })), findings };

  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}
