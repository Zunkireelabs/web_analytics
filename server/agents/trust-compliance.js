import * as cheerio from 'cheerio';
import { fetchHtml, effortForGenerator } from './lib/page-content.js';
import { getSiteById } from '../store/read.js';
import { knownDomain, resolveOwnDomain } from './lib/site-domain.js';
import { makeFinding, impactFromPriority } from './lib/findings.js';
import { collectSiteTrackerFacts } from './lib/site-trackers.js';
import { callLLM } from '../llm.js';

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
async function resolveLinkStatus(href, homepageUrl, homepageTitle) {
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
  const linkedTitle = cheerio.load(result.html)('title').first().text().trim();
  if (homepageTitle && linkedTitle === homepageTitle) {
    return { ok: false, reason: 'the link target renders the same page as the homepage (likely a dead/fallback route)', href: absoluteUrl };
  }
  return { ok: true, href: absoluteUrl };
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

  const checkResults = await Promise.all(PAGE_CHECKS.map(async (check) => {
    const match = links.find((l) => check.hrefPattern.test(l.href) || check.textPattern.test(l.text));
    if (!match) return { check, status: 'missing' };
    const linkStatus = await resolveLinkStatus(match.href, homepageUrl, homepageTitle);
    return linkStatus.ok
      ? { check, status: 'ok' }
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
