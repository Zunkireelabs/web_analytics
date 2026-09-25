import * as cheerio from 'cheerio';
import { getSiteById } from '../store/read.js';
import { siteOriginFor } from './lib/site-domain.js';
import { fetchHtml, isPrivateOrLocalHost } from './lib/page-content.js';
import { priorityByRank, impactFromPriority, makeFinding } from './lib/findings.js';

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
  version: 1,
};

// Deliberately broad, not funnel-specific — "book a demo" and "start free
// trial" and "get a quote" are all the same underlying pattern (a visitor
// clicking their way toward the site's own configured conversion event,
// whatever that is — see product_growth_config.conversion_event).
const CTA_TEXT_PATTERN = /\b(book|schedule|request|get)\b.{0,15}\b(demo|call|quote|consultation)\b|\bstart\b.{0,15}\btrial\b|\bsign\s?up\b|\bget\s?started\b|\bcontact\s?(us|sales)\b/i;

async function checkDestination(href, origin) {
  if (!href || href === '#' || href.trim() === '') {
    return { ok: false, reason: 'empty or "#" href — goes nowhere.' };
  }
  if (href.startsWith('mailto:')) {
    return { ok: false, reason: `opens an email client (${href}) instead of a page on the site.` };
  }
  if (href.startsWith('tel:')) {
    return { ok: true, reason: null }; // a real phone CTA is a legitimate destination, not a defect
  }

  let absolute;
  try { absolute = new URL(href, origin).href; } catch { return { ok: false, reason: `"${href}" is not a resolvable URL.` }; }

  const hostname = new URL(absolute).hostname;
  if (isPrivateOrLocalHost(hostname)) return { ok: false, reason: `"${href}" resolves to a private/local address.` };

  const fetched = await fetchHtml(absolute);
  if (!fetched.ok) return { ok: false, reason: `"${absolute}" did not load (${fetched.error}).` };
  return { ok: true, reason: null };
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

  const $ = cheerio.load(homepage.html);
  const ctaCandidates = [];
  $('a[href], button').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text || !CTA_TEXT_PATTERN.test(text)) return;
    const href = $(el).attr('href') || $(el).closest('a[href]').attr('href') || null;
    ctaCandidates.push({ text, href });
  });

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
    whyItMatters: `The "${c.text}" call-to-action on the homepage ${c.reason} A real visitor clicking this never reaches a working page.`,
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

  const facts = { origin, ctaCandidates: checked.map(({ text, href, ok, reason }) => ({ text, href, ok, reason })), findings };

  return { meta, status: 'ok', facts, narrative: null, generatedAt: new Date().toISOString() };
}
