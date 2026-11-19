import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { parseRobotsGroups, evaluateAccess, partialRestrictions } from './robotsAccess.js';
import { validateBlock } from './schemaRules.js';
import aiCrawlerAccess from './checks/aeo/aiCrawlerAccess.js';
import structuredDataRich from './checks/aeo/structuredDataRich.js';
import identitySchema from './checks/aeo/identitySchema.js';
import canonical from './checks/seo/canonical.js';
import hreflang from './checks/seo/hreflang.js';

const page = (head) => cheerio.load(`<html><head>${head}</head><body></body></html>`);
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const robots = (content) => ({ robotsTxt: { present: true, content } });

// ---- robots.txt evaluator (RFC 9309) ----
test('Allow beats Disallow on a tie, longest rule wins', () => {
  const g = parseRobotsGroups('User-agent: *\nDisallow: /\nAllow: /');
  assert.equal(evaluateAccess(g, 'GPTBot', '/').allowed, true);
  const g2 = parseRobotsGroups('User-agent: *\nDisallow: /private\nAllow: /private/public');
  assert.equal(evaluateAccess(g2, 'X', '/private/a').allowed, false);
  assert.equal(evaluateAccess(g2, 'X', '/private/public/a').allowed, true);
});

test('a bot with its own group ignores the * group; otherwise * applies', () => {
  const g = parseRobotsGroups('User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /');
  assert.equal(evaluateAccess(g, 'OAI-SearchBot', '/').allowed, true);
  const other = evaluateAccess(g, 'PerplexityBot', '/');
  assert.equal(other.allowed, false);
  assert.equal(other.viaWildcard, true);
});

test('groups for the same bot merge; wildcards and $ work; empty Disallow blocks nothing', () => {
  const g = parseRobotsGroups('User-agent: GPTBot\nDisallow: /a\n\nUser-agent: GPTBot\nDisallow: /b');
  assert.equal(evaluateAccess(g, 'gptbot', '/a/x').allowed, false);
  assert.equal(evaluateAccess(g, 'gptbot', '/b/x').allowed, false);
  assert.equal(evaluateAccess(parseRobotsGroups('User-agent: *\nDisallow: /*.pdf$'), 'X', '/f.pdf').allowed, false);
  assert.equal(evaluateAccess(parseRobotsGroups('User-agent: *\nDisallow: /*.pdf$'), 'X', '/f.pdf?x').allowed, true);
  assert.equal(evaluateAccess(parseRobotsGroups('User-agent: *\nDisallow:'), 'X', '/').allowed, true);
  assert.deepEqual(partialRestrictions(parseRobotsGroups('User-agent: *\nDisallow: /blog/\nDisallow: /'), 'X'), ['/blog/']);
});

// ---- AI crawler check ----
test('Disallow: / with a later Allow: / is NOT reported as blocked (old code said blocked)', () => {
  const r = aiCrawlerAccess(robots('User-agent: *\nDisallow: /\nAllow: /'));
  assert.equal(r.passed, true);
});

test('blocking only training bots (GPTBot, ClaudeBot) passes; blocking a search bot fails', () => {
  const trainingOnly = aiCrawlerAccess(robots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /'));
  assert.equal(trainingOnly.passed, true);
  assert.match(trainingOnly.message, /GPTBot/);
  const search = aiCrawlerAccess(robots('User-agent: OAI-SearchBot\nDisallow: /'));
  assert.equal(search.passed, false);
  assert.match(search.message, /OAI-SearchBot/);
});

test('site-wide * block is reported, with the wildcard explanation; a dedicated Allow group rescues that bot', () => {
  const r = aiCrawlerAccess(robots('User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /'));
  assert.equal(r.passed, false);
  assert.doesNotMatch(r.message, /OAI-SearchBot \(/);
  assert.match(r.message, /no group of its own/);
});

test('partial restriction is noted but not penalised', () => {
  const r = aiCrawlerAccess(robots('User-agent: *\nDisallow: /blog/'));
  assert.equal(r.passed, true);
  assert.match(r.message, /\/blog\//);
});

// ---- schema required properties ----
test('FAQPage with no questions, and Product with no name, are incomplete', () => {
  assert.deepEqual(validateBlock({ '@type': 'FAQPage' })[0].missingRequired, ['mainEntity']);
  const p = validateBlock({ '@type': 'Product' })[0];
  assert.ok(p.missingRequired.includes('name'));
  assert.ok(p.missingRequired.some((m) => m.startsWith('one of offers')));
});

test('FAQPage questions without answers are flagged', () => {
  const f = validateBlock({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?' }] })[0];
  assert.match(f.missingRequired[0], /1 of 1 questions/);
  const ok = validateBlock({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { text: 'A.' } }] })[0];
  assert.deepEqual(ok.missingRequired, []);
});

test('rich-structured-data: complete passes full, incomplete scores 1 of 3, none is not applicable', () => {
  const good = structuredDataRich({ $: page(ld({ '@type': 'Article', headline: 'H', author: 'A' })) });
  assert.equal(good.score, 3);
  const bad = structuredDataRich({ $: page(ld({ '@type': 'FAQPage' })) });
  assert.equal(bad.passed, false);
  assert.equal(bad.score, 1);
  assert.equal(bad.maxScore, 3);
  const none = structuredDataRich({ $: page('') });
  assert.equal(none.maxScore, 0);
});

test('schema nested in @graph is validated too', () => {
  const r = structuredDataRich({ $: page(ld({ '@graph': [{ '@type': 'Product' }] })) });
  assert.equal(r.passed, false);
});

// ---- identity schema ----
test('name-only Organization no longer gets full marks; sameAs/url/logo complete it', () => {
  const nameOnly = identitySchema({ $: page(ld({ '@type': 'Organization', name: 'Acme' })) });
  assert.equal(nameOnly.passed, false);
  assert.equal(nameOnly.score, 3);
  assert.match(nameOnly.message, /sameAs/);
  const full = identitySchema({ $: page(ld({ '@type': 'Organization', name: 'Acme', url: 'https://acme.io', logo: 'https://acme.io/l.png', sameAs: ['https://linkedin.com/company/acme'] })) });
  assert.equal(full.passed, true);
  assert.equal(full.score, 6);
});

test('placeholder sameAs values (REPLACE_...) from our own sample fix do not count', () => {
  const r = identitySchema({ $: page(ld({ '@type': 'Organization', name: 'Acme', url: 'https://acme.io', logo: 'REPLACE_LOGO_URL', sameAs: ['REPLACE_LINKEDIN_URL'] })) });
  assert.equal(r.passed, false);
  assert.equal(r.score, 4);
});

test('no identity block at all still scores 0', () => {
  assert.equal(identitySchema({ $: page('') }).score, 0);
});

// ---- canonical ----
const canon = (head, extra = {}) => canonical({ $: page(head), finalUrl: 'https://a.com/p', ...extra });

test('canonical: self-referencing and healthy target pass; missing tag fails', () => {
  assert.equal(canon('<link rel="canonical" href="https://a.com/p">', { canonicalTarget: { checked: false, selfReferencing: true } }).score, 5);
  assert.equal(canon('<link rel="canonical" href="https://a.com/q">', { canonicalTarget: { checked: true, status: 200 } }).score, 5);
  assert.equal(canon('').score, 0);
});

test('canonical: target 404, redirect, noindex, and conflicting tags are failures', () => {
  const t = (ct) => canon('<link rel="canonical" href="https://a.com/q">', { canonicalTarget: ct });
  assert.equal(t({ checked: true, status: 404 }).passed, false);
  assert.match(t({ checked: true, status: 404 }).message, /404/);
  assert.match(t({ checked: true, status: 301, redirectedTo: '/z' }).message, /redirects/);
  assert.match(t({ checked: true, status: 200, noindex: true }).message, /noindex/);
  const multi = canon('<link rel="canonical" href="https://a.com/q"><link rel="canonical" href="https://a.com/r">');
  assert.equal(multi.passed, false);
  assert.match(multi.message, /2 different canonical/);
});

test('canonical: identical duplicate tags are not a conflict; unreachable probe (null) does not fail the page', () => {
  assert.equal(canon('<link rel="canonical" href="https://a.com/q"><link rel="canonical" href="https://a.com/q">', { canonicalTarget: null }).passed, true);
});


// ---- bot probe (shapes copied from a real run against airbnb.com / apple.com) ----
const okProbe = { checked: true, baselineStatus: 200, bots: [
  { token: 'OAI-SearchBot', status: 200, blocked: false, challenged: false },
  { token: 'PerplexityBot', status: 200, blocked: false, challenged: false } ] };
const blockedProbe = { checked: true, baselineStatus: 200, bots: [
  { token: 'OAI-SearchBot', status: 403, blocked: true, challenged: true },
  { token: 'PerplexityBot', status: 200, blocked: false, challenged: false } ] };

test('bot probe: robots allows but the firewall blocks -> still passes, but warns by name', () => {
  const r = aiCrawlerAccess({ ...robots('User-agent: *\nAllow: /'), botProbe: blockedProbe });
  assert.equal(r.passed, true);
  assert.equal(r.score, 5);
  assert.match(r.message, /Firewall\/CDN signal/);
  assert.match(r.message, /OAI-SearchBot \(challenge page\)/);
  assert.match(r.recommendation, /CDN\/WAF/);
});

test('bot probe: clean probe says so; missing or unchecked probe changes nothing', () => {
  assert.match(aiCrawlerAccess({ ...robots('User-agent: *\nAllow: /'), botProbe: okProbe }).message, /served normally/);
  const plain = aiCrawlerAccess(robots('User-agent: *\nAllow: /'));
  assert.doesNotMatch(plain.message, /Firewall|served normally/);
  assert.deepEqual(aiCrawlerAccess({ ...robots('User-agent: *\nAllow: /'), botProbe: { checked: false, bots: [] } }), plain);
});

// ---- hreflang (probe shapes copied from a real run against airbnb.com) ----
const hl = (links) => cheerio.load(`<html><head>${links.map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${h}">`).join('')}</head></html>`);
const tag = (lang, href) => ({ lang, raw: href, href, absolute: /^https?:/.test(href) });
const good = [['en', 'https://a.com/'], ['de', 'https://a.com/de/'], ['x-default', 'https://a.com/']];

test('hreflang: no tags = not applicable (unchanged)', () => {
  assert.equal(hreflang({ $: page(''), finalUrl: 'https://a.com/' }).passed, null);
});

test('hreflang: valid, self-referencing, reciprocal set passes with full score', () => {
  const probe = { tags: good.map(([l, h]) => tag(l, h)), probed: [{ lang: 'de', url: 'https://a.com/de/', status: 200, redirectedTo: null, noindex: false, returnsLink: true, canonicalElsewhere: null }], capped: false };
  const r = hreflang({ $: hl(good), finalUrl: 'https://a.com/', hreflangProbe: probe });
  assert.equal(r.passed, true);
  assert.equal(r.score, 3);
});

test('hreflang: bad code, relative url, missing self reference, no x-default', () => {
  const links = [['english', '/en/'], ['de', 'https://a.com/de/']];
  const r = hreflang({ $: hl(links), finalUrl: 'https://a.com/en/' });
  assert.equal(r.passed, false);
  assert.match(r.message, /invalid language\/region code: english/);
  assert.match(r.message, /not fully qualified/);
  assert.match(r.message, /does not list itself/);
  assert.match(r.message, /no x-default/);
});

test('hreflang: same code to two URLs, missing return link, noindex, canonical elsewhere, error', () => {
  const links = [['en', 'https://a.com/'], ['de', 'https://a.com/de/'], ['de', 'https://a.com/de2/'], ['fr', 'https://a.com/fr/']];
  const probe = { tags: links.map(([l, h]) => tag(l, h)), capped: false, probed: [
    { lang: 'de', url: 'https://a.com/de/', status: 200, returnsLink: false, noindex: false, canonicalElsewhere: null, redirectedTo: null },
    { lang: 'fr', url: 'https://a.com/fr/', status: 404, returnsLink: null, noindex: true, canonicalElsewhere: 'https://b.com/', redirectedTo: null } ] };
  const r = hreflang({ $: hl(links), finalUrl: 'https://a.com/', hreflangProbe: probe });
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  for (const re of [/same code points at different URLs: de/, /no return link from: de/, /returns an error: fr \(404\)/, /noindex: fr/, /canonical points to another URL: fr/]) assert.match(r.message, re);
});

test('hreflang: a probe that could not fetch an alternate does not invent an error', () => {
  const probe = { tags: good.map(([l, h]) => tag(l, h)), capped: false, probed: [{ lang: 'de', url: 'https://a.com/de/', error: true }] };
  const r = hreflang({ $: hl(good), finalUrl: 'https://a.com/', hreflangProbe: probe });
  assert.equal(r.passed, true);
  assert.match(r.message, /could not be fetched/);
});
