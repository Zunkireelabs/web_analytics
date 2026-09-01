import * as cheerio from 'cheerio';
import { fetchHtml, effortForGenerator } from './lib/page-content.js';
import { getSiteById } from '../store/read.js';
import { knownDomain, resolveOwnDomain } from './lib/site-domain.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { collectSiteTrackerFacts, trackerAbsenceIsProvable } from './lib/site-trackers.js';
import { callLLM } from '../llm.js';
import { componentTemplateVerification } from '../implementers/lib/design-drift.js';

export const meta = {
  id: 'trust-compliance',
  name: 'Trust & Compliance Agent',
  description: 'Checks the site\'s own homepage for links to a Cookie Policy, Privacy Policy, and Terms of Service — real trust signals for visitors and crawlers, not a legal compliance audit.',
  category: 'compliance',
  version: 1,
  // No external data source — every signal here is read directly off the
  // site's own real homepage HTML and HTTP response, same self-sufficiency
  // as security-headers.js.
};

// A finding here means either "no link to it found on the homepage" or "a
// link exists but doesn't lead to a real, distinct page" (redirects back to
// the homepage, or a catch-all route silently re-serves the homepage under a
// different path) — both real, checkable trust signals for visitors and
// crawlers. It is deliberately NOT a claim that the site is legally
// non-compliant (this agent has no way to know that), which is why every
// generated finding/narrative is framed as a trust signal, never as legal
// advice.
const PAGE_CHECKS = [
  {
    key: 'cookie-policy', label: 'Cookie Policy',
    hrefPattern: /cookie/i, textPattern: /cookie policy|cookies? (settings|preferences)/i,
  },
  {
    key: 'privacy-policy', label: 'Privacy Policy',
    hrefPattern: /privacy/i, textPattern: /privacy policy|privacy notice/i,
  },
  {
    key: 'terms-of-service', label: 'Terms of Service',
    hrefPattern: /terms/i, textPattern: /terms of service|terms (and|&) conditions|terms of use/i,
  },
];

// origin + pathname only, trailing slash and case insensitive — enough to
// tell "this is the same page" from "this is a different page" without
// false negatives over a query string or #fragment difference.
function normalizePath(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`.toLowerCase();
  } catch { return url; }
}

// A link "resolving" means more than a 200 response — a same-origin SPA/CMS
// very commonly answers every unknown path with its homepage (client-side
// router fallback, or a catch-all route), which looks like success unless
// checked. Three real, cheap signals catch that without executing any
// client-side JS: the href already pointing at the homepage path itself,
// the response redirecting back to the homepage, or the fetched page
// rendering the exact same <title> as the homepage.
// body().text(), whitespace-collapsed — same normalization duplicate-content.js
// uses before its own real exact-match hash comparison.
function normalizedBodyText(html) {
  return cheerio.load(html)('body').text().replace(/\s+/g, ' ').trim();
}

async function resolveLinkStatus(href, homepageUrl, homepageTitle, homepageBodyText) {
  let absoluteUrl;
  try { absoluteUrl = new URL(href, homepageUrl).toString(); } catch { return { ok: false, reason: 'link has no usable URL' }; }
  if (normalizePath(absoluteUrl) === normalizePath(homepageUrl)) {
    return { ok: false, reason: 'the link itself points at the homepage, not a distinct page', href: absoluteUrl };
  }
  const result = await fetchHtml(absoluteUrl);
  if (!result.ok) return { ok: false, reason: `link target is unreachable (${result.error})`, href: absoluteUrl };
  if (result.url && normalizePath(result.url) === normalizePath(homepageUrl)) {
    return { ok: false, reason: 'the link redirects back to the homepage', href: absoluteUrl };
  }
  const $linked = cheerio.load(result.html);
  const linkedTitle = $linked('title').first().text().trim();
  // Title match ALONE isn't enough — a real, distinct page can legitimately
  // reuse the site's generic sitewide <title> tag (a common authoring
  // mistake, not a fake route). A genuine client-side-router/CMS fallback
  // re-serves the exact same rendered page, so its real body text is
  // identical too — requiring both together is what actually distinguishes
  // "this is really the homepage again" from "this page just has a lazy title".
  const linkedBodyText = normalizedBodyText(result.html);
  if (homepageTitle && linkedTitle === homepageTitle && homepageBodyText && linkedBodyText === homepageBodyText) {
    return { ok: false, reason: 'the link target renders the same page as the homepage (likely a dead/fallback route)', href: absoluteUrl };
  }
  return { ok: true, href: absoluteUrl };
}

// A compliance page whose homepage LINK resolves fine (status 'ok' above)
// can still be visually inconsistent with the rest of the site — it was
// generated/hand-written before this site's design profile/contentWrapper
// template existed, or before either was verified against the site's real
// CSS. Nothing before this proactively re-checked an already-shipped
// compliance page once its link stopped being the problem — this is the
// gap: a visual/structural drift detector for compliance pages specifically
// (spec: "if they already exist, determine whether they visually belong to
// the tenant's website").
//
// Deliberately reuses componentTemplateVerification (design-drift.js) —
// the SAME verdict routes/action-center.js's generateDraft gate already
// computes to decide whether regenerating this action type right now would
// produce real, site-styled markup or a bare fallback — rather than a new
// vision/screenshot pass. A site-wide verdict, not a per-page one: this
// site's compliance pages all share the one 'content-wrapper' template
// (design-drift.js's COMPONENT_TEMPLATE_KEY), so one check covers every
// resolved page. When it's already ok, there's nothing to flag — this
// function never invents a defect a real check didn't find.
export function buildComplianceDesignDriftFindings(resolvedPages, wrapperVerification, trackerFacts, homepageUrl) {
  if (wrapperVerification?.ok || !resolvedPages.length) return [];
  return resolvedPages.map(({ check, href }) => makeFinding({
    id: `trust-compliance:${check.key}:design-drift`,
    evidence: {
      page: href || homepageUrl,
      wrapperVerification: { ok: wrapperVerification.ok, reason: wrapperVerification.reason },
    },
    whyItMatters: `The ${check.label} page is linked and reachable, but this site's real content template (the wrapper that gives generated pages the site's own typography/spacing) is ${wrapperVerification.reason === 'missing' ? 'not derived yet' : 'not yet verified against the live site'} — this page may be rendering with generic or unstyled markup instead of looking like the rest of the site.`,
    priority: 'low',
    recommendedAction: {
      label: `Regenerate ${check.label} to match the site's current design`,
      generatorId: check.key,
      params: {
        siteName: trackerFacts.siteName,
        domain: trackerFacts.domain,
        cookiesObserved: trackerFacts.cookiesObserved,
        trackersDetected: trackerFacts.trackersDetected,
        page: href || null,
      },
      effort: effortForGenerator(check.key),
    },
    expectedImpact: { label: impactFromPriority('low'), basis: 'computed', value: 0 },
  }));
}

export async function run({ siteId, start, end }) {
  const site = await getSiteById(siteId);
  const domain = knownDomain(site) || (await resolveOwnDomain(site, siteId, start, end));
  if (!domain) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No known site domain yet.', generatedAt: new Date().toISOString(),
    };
  }

  const homepageUrl = `https://${domain}/`;
  const htmlResult = await fetchHtml(homepageUrl);
  if (!htmlResult.ok) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: `Could not fetch homepage: ${htmlResult.error}`, generatedAt: new Date().toISOString(),
    };
  }

  const $ = cheerio.load(htmlResult.html);
  const links = $('a[href]').map((_, el) => ({
    href: $(el).attr('href') || '', text: $(el).text().trim(),
  })).get();
  const homepageTitle = $('title').first().text().trim();
  const homepageBodyText = normalizedBodyText(htmlResult.html);

  const checkResults = await Promise.all(PAGE_CHECKS.map(async (check) => {
    const match = links.find((l) => check.hrefPattern.test(l.href) || check.textPattern.test(l.text));
    if (!match) return { check, status: 'missing' };
    const linkStatus = await resolveLinkStatus(match.href, homepageUrl, homepageTitle, homepageBodyText);
    return linkStatus.ok
      ? { check, status: 'ok', href: linkStatus.href }
      : { check, status: 'broken', reason: linkStatus.reason, href: linkStatus.href };
  }));

  const trackerFacts = await collectSiteTrackerFacts(site, homepageUrl);

  const findings = checkResults.filter((r) => r.status !== 'ok').map((r) => {
    const { check } = r;
    const whyItMatters = r.status === 'missing'
      ? `No link to a ${check.label} was found on the homepage — a common trust signal for visitors, and something AI/search crawlers look for when assessing site credibility.`
      : `The homepage links to a ${check.label}, but ${r.reason} — a visitor clicking it sees no real ${check.label}.`;
    return makeFinding({
      id: `trust-compliance:${check.key}:${r.status}`,
      evidence: {
        page: homepageUrl,
        linkStatus: r.status,
        ...(r.href ? { href: r.href } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        cookiesObserved: trackerFacts.cookiesObserved,
        trackersDetected: trackerFacts.trackersDetected,
      },
      whyItMatters,
      priority: 'medium',
      recommendedAction: {
        label: `Draft ${check.label}`,
        generatorId: check.key,
        params: {
          siteName: trackerFacts.siteName,
          domain: trackerFacts.domain,
          cookiesObserved: trackerFacts.cookiesObserved,
          trackersDetected: trackerFacts.trackersDetected,
          // The real existing page the homepage already links to (broken
          // link case only — r.href). Lets the frontend implementer target
          // that real file via url_file_map.pages instead of always
          // creating a new, unlinked page (resolveNewContentTarget) — a
          // 'missing' link has no existing page to target, so this stays
          // null and net-new creation remains the only option there.
          page: r.href || null,
        },
        effort: effortForGenerator(check.key),
      },
      expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
    });
  });

  // Design/visual drift on the compliance pages that ARE correctly linked —
  // see buildComplianceDesignDriftFindings above.
  const resolvedCompliancePages = checkResults.filter((r) => r.status === 'ok').map((r) => ({ check: r.check, href: r.href }));
  const wrapperVerification = componentTemplateVerification(site, 'content-wrapper');
  findings.push(...buildComplianceDesignDriftFindings(resolvedCompliancePages, wrapperVerification, trackerFacts, homepageUrl));

  // Analytics/Pixel install checks — real detections from site-trackers.js,
  // just never surfaced as their own finding before (only as evidence
  // context on the cookie/privacy/terms findings above). Unlike most
  // page-weight/infra findings in this codebase, this one IS draftable: the
  // analytics-install generator can produce the real install script — it
  // just can't invent the site's own GA4 measurement ID / Pixel ID, so the
  // draft ships with a placeholder blocking auto-publish until a human fills
  // in the real ID (see generators/analytics-install.js).
  const TRACKER_CHECKS = [
    { label: 'Google Analytics (GA4)', id: 'analytics', provider: 'ga4', trackingId: site.ga4_measurement_id || null, whyItMatters: 'No Google Analytics (or equivalent) tracking script was detected on the homepage — without it, this site has no way to measure real visitor traffic, conversions, or which pages are actually working.' },
    { label: 'Meta/Facebook Pixel', id: 'facebook-pixel', provider: 'facebook-pixel', trackingId: null, whyItMatters: 'No Meta/Facebook Pixel was detected on the homepage — without it, ad conversions and retargeting audiences can\'t be tracked for any Facebook/Instagram ad campaigns run for this site.' },
  ];
  // trackerAbsenceIsProvable gates the whole check: these two findings assert
  // a NEGATIVE ("no GA4 on this page"), and site-trackers.js can only read
  // static HTML, so a Google Tag Manager container on the page makes that
  // negative unknowable — GTM loads its tags at runtime. Filing the finding
  // anyway told every GTM-based tenant their live analytics was missing and
  // offered to install a second copy of it (double-counted pageviews). No
  // finding is the honest output there, not a hedged one.
  const trackerFindings = (trackerAbsenceIsProvable(trackerFacts) ? TRACKER_CHECKS : [])
    .filter((t) => !trackerFacts.trackersDetected.includes(t.label)).map((t) => makeFinding({
    id: `trust-compliance:${t.id}:missing`,
    evidence: { page: homepageUrl, trackersDetected: trackerFacts.trackersDetected },
    whyItMatters: t.whyItMatters,
    priority: 'medium',
    recommendedAction: {
      label: `Draft ${t.label} install script`,
      generatorId: 'analytics-install',
      params: { provider: t.provider, page: homepageUrl, ...(t.trackingId ? { trackingId: t.trackingId } : {}) },
      effort: effortForGenerator('analytics-install'),
    },
    expectedImpact: { label: impactFromPriority('medium'), basis: 'computed', value: 0 },
  }));
  findings.push(...trackerFindings);

  const facts = {
    homepageUrl,
    checked: checkResults.map((r) => ({ key: r.check.key, status: r.status, reason: r.reason || null })),
    trackerFacts,
    findings,
  };

  const system = 'You are a trust & compliance analyst writing for a non-technical site owner. Given the status ' +
    '(missing / broken / ok) of each common trust page (Cookie Policy, Privacy Policy, Terms of Service) checked ' +
    'on the homepage, and which real cookies/trackers were actually observed on the site, write 2-3 sentences ' +
    'naming what\'s wrong. Clearly distinguish "no link exists at all" from "a link exists but doesn\'t lead to a ' +
    'real page" (e.g. it redirects back to or re-renders the homepage) — these are different problems for the ' +
    'site owner to fix. This is NOT a legal compliance audit — never phrase it as a legal judgment, and never ' +
    'invent a cookie, tracker, or claim not present in the given facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 220 })
      .catch((err) => { console.warn('[agents] trust-compliance narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
