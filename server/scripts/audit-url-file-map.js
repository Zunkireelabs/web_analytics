import 'dotenv/config';
import { pool, recordActionCenterConfigCheck } from '../db.js';
import { listAreas, siteForArea } from '../implementers/lib/site-areas.js';
import { getSiteById, getSearchPerformanceRange } from '../store/read.js';
import { listConnectedSites } from '../job.js';
import { resolveFile, resolveActionFile, resolveMarkers, resolveAdapter, resolveNotApplicable, resolveNewContentNotApplicable, resolveSiteRootFile, resolveAuthorAvatars } from '../implementers/lib/url-file-map.js';
import { parseSvgDimensions, classifyAvatarAspectGap } from '../implementers/lib/avatar-aspect-check.js';
import { hasMarker, classifyMarkerGap, isHeadScopedField } from '../implementers/lib/marker-merge.js';
import { preDraftContentBlock } from '../implementers/lib/action-scope.js';
import { hasHashMarker, ensureHashMarker, locationsDroppingServerHeaders } from '../implementers/lib/hash-marker-merge.js';
import { detectInsertionPoint, detectHeadRegion } from '../implementers/lib/structural-detect.js';
import { resolveCapability, extensionOf } from '../implementers/lib/rendering-gate.js';
import { knownDomain, ownDomains, filterOwnDomainPages } from '../agents/lib/site-domain.js';
import { getFileContent, getDefaultBranchSha, defaultBranchName, prTargetBranchName } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { findRelevantMemory } from '../agent-memory.js';
import { scanRepoForTracking } from '../lib/repo-tracking-scan.js';
import { fetchHtml } from '../agents/lib/page-content.js';
import { probeMany } from '../agents/lib/live-probe.js';

// Read-only config-completeness audit for a site's url_file_map — surfaces
// exactly the class of gap that let the homepage-FAQ and /compare/-FAQ
// drafts get stuck ("No url_file_map entry matches...", "No markers
// configured...") BEFORE an agent ever recommends a page nothing can
// deploy to, instead of discovering it only at approve/push time.
//
// Config-completeness alone isn't enough, though — a real incident showed
// url_file_map can still declare a marker name that config-wise looks fine
// while the actual `SEOAI:<name>` comment has quietly vanished from the live
// file (e.g. after a client-side template redesign that never touched this
// app). This audit fetches each configured file's real live content and
// checks with hasMarker(), so that class of drift is caught here,
// proactively, instead of burning generation + review time on a draft that
// can never actually apply.
//
// A missing marker isn't automatically fatal, though — marker-merge.js's
// ensureMarkers() auto-creates most marker types at apply time (see its
// module comment). classifyMarkerGap (same module, imported above) is the
// single source of truth both this script and ensureMarkers use for "will
// this heal itself, or does it need a real human-placed anchor first" — so
// a missing BLOCK marker (schema/faq/links) is reported as self-healing
// noise, not counted as a real gap, and the count/summary below reflects
// only what genuinely needs a person: no file mapping, no markers
// configured at all, a missing file, or a marker gap classifyMarkerGap
// calls fatal (no front matter / no HEAD region / no safe body anchor).
// classifyMarkerGap now runs the same real structural detectors
// (structural-detect.js) the insertion engine itself uses (passed in as
// DETECTORS below) rather than a static field allowlist, so this script's
// "self-heals" count can never silently drift from what actually self-heals
// at apply time.
const DETECTORS = { detectBody: detectInsertionPoint, detectHead: detectHeadRegion };
//
// The nginx security-headers marker gets its own dedicated check (below,
// separate from ACTION_TYPES) since it's a site-root marker, not a
// per-page one, and — unlike every other marker type — can never be
// auto-created at apply time (see generators/security-headers.js): there's
// no framework-agnostic way to guess where inside an arbitrary nginx
// `server {}` block it belongs, so it's the one marker this audit must
// name explicitly rather than fold into a generic per-page count.
//
//   node server/scripts/audit-url-file-map.js --site-id <id> [--no-record]
//   --no-record: read-only — do not write action_center_config_checked_at / gap_count.
//
// --all is accepted but not yet wired to real multi-site iteration — see
// the note above main(). Structured now (auditSite() takes one siteId,
// called from a siteIds loop) so wiring --all later is additive, not a
// rewrite: swap the single-id array for listConnectedSites()'s ids.

// Every PER-PAGE action type marker-merge.js's buildMergeValues() knows how
// to splice (its own `actionType === '...'` branches) — kept in sync with
// that list by hand since there's no registry to read it from generically.
// Used to be just 4 of these, which is exactly how a real "no markers
// configured" gap on analytics-install went undetected by this audit even
// after every other fix in this file: the audit simply never asked about
// it. llms-txt/robots.txt/sitemap (site-root, not per-page) and
// blog-outline/landing-page/translation (net-new content, no existing
// marker to check) are deliberately excluded — they're not marker-based.
const ACTION_TYPES = ['meta-title', 'faq', 'schema', 'internal-links', 'canonical', 'open-graph', 'expand-content', 'qa-content'];

// Every net-new-content action type a recommendation agent can generate for
// ANY site, regardless of what this particular site's keyword/GSC data
// happens to surface at onboarding time — unlike ACTION_TYPES above, these
// have no existing page to check a marker against; the only real question is
// whether url_file_map.newContentTargets has an entry to write one to at
// all. Not knowing in advance which of these a site's growth agents will
// eventually ask for is exactly why this has to be a proactive checklist
// run once at onboarding rather than a per-recommendation surprise: Admizz
// (site 8862) onboarded with only landing-page/cookie-policy/terms-of-service
// configured, and its first blog-outline/direct-answer/translation
// recommendations sat blocked with "no url_file_map.newContentTargets[...]
// configured" for days before anyone noticed (2026-09-11).
const NEW_CONTENT_ACTION_TYPES = [
  'landing-page', 'blog-outline', 'direct-answer', 'translation',
  'cookie-policy', 'privacy-policy', 'terms-of-service',
];

// analytics-install is marker-based too, but SITEWIDE (installs GA4/Meta
// Pixel once, in the site's shared layout template) rather than per-page —
// backend.js's computeMarkerMerge routes it through
// url_file_map.siteRoot.layoutTemplate + defaults.placements, not
// resolveFile(page), so it needs its own dedicated check (below, alongside
// the nginx marker) instead of being folded into the per-page ACTION_TYPES
// loop, where it would incorrectly report "no file mapping" once per page.
const DEFAULT_WINDOW_DAYS = 90;
const PAGE_LIMIT = 300;

// The file an action type will really read/write for a page: the mapping may route one action type to
// a different file than the page file (a per-page <head> partial). Falls back to the page file.
function fileForAction(site, pageUrl, actionType, pageFile) {
  return resolveActionFile(site, pageUrl, actionType) || pageFile;
}

// Whether the site's own repository already loads Google tracking (GA4 ID, gtag loader, GTM container,
// consent-gated or dynamic loaders like analytics.js — scanRepoForTracking reads the whole archive, not
// just the layout). When it does, an analytics-install draft can only DUPLICATE it (double-counting, and
// for a consent-gated site loading a tag before consent), so "install marker missing" is not a config gap
// and the generator's own duplicate guard (analytics-install.js verifyCurrentState) dismisses it. A scan
// that could not run says nothing either way — the caller keeps the normal marker check.
function summarizeExistingTracking(scan) {
  if (!scan?.ok) return null;
  const hits = scan.refs.flatMap((r) => r.hits.map((h) => ({ ...h, ref: r.ref })));
  if (!hits.length) return null;
  return {
    files: [...new Set(hits.map((h) => `${h.ref}:${h.path}`))].slice(0, 6),
    ga4: [...new Set(hits.flatMap((h) => h.ga4))].slice(0, 4),
    gtm: [...new Set(hits.flatMap((h) => h.gtm))].slice(0, 4),
  };
}

// What the security-headers path would really do with this nginx file, using the SAME primitives the
// implementer uses (backend.js computeSecurityHeadersMerge). The marker is NOT always hand-placed: the
// engine auto-inserts it into the serving server block. It only refuses when nginx would not apply a
// server-level header inside a location that sets its own add_header (`headers-not-inherited`) or when
// there is no serving server block to place it in. Statuses:
//   present       marker already there
//   self-heals    auto-inserted at apply time and inherited everywhere — nothing to do
//   blocked       the implementer REFUSES (headers-not-inherited): a genuine safety warning, not a config gap
//   fatal         no serving server block to place a marker in (needs a human)
function classifyNginxMarker(content) {
  if (hasHashMarker(content, 'SECURITY-HEADERS')) return { status: 'present' };
  const placed = ensureHashMarker(content, 'SECURITY-HEADERS');
  if (!placed.ok) return { status: 'fatal', reason: placed.reason };
  const dropped = locationsDroppingServerHeaders(content);
  if (dropped.length) return { status: 'blocked', reason: 'headers-not-inherited', locations: dropped };
  return { status: 'self-heals' };
}

// Net-new types whose renderer emits CODE (a TSX/JSX component) instead of Markdown when the target names a
// `filename` (App Router directory-per-page). frontend.js returns contentFormat 'jsx' for these (blog-outline,
// direct-answer, translation), and rendering-gate.js only checks Markdown capability for contentFormat
// 'markdown' — so the gate never runs for them and a ".tsx recorded-not-markdown-safe" finding is a false
// positive (Admizz). landing-page and the compliance pages have no code branch: they always render Markdown
// + front matter, so their .tsx findings are real and must stay.
const CODE_RENDERER_TYPES = new Set(['blog-outline', 'direct-answer', 'translation']);
function targetRendersCode(actionType, target) {
  // A converted static site (MOBILISE) writes each new blog post as a hand-written HTML page in an .njk file, by copying a real sibling post
  // (newContentTargets["blog-outline"].mode = "clone-sibling"). frontend.js tags it contentFormat 'html-page', so the Markdown gate never runs for it either.
  if (actionType === 'blog-outline' && target?.mode === 'clone-sibling') return true;
  return CODE_RENDERER_TYPES.has(actionType) && !!target?.filename && /^\.(tsx|jsx)$/i.test(String(target.extension || ''));
}

// A "fatal" marker gap on an action the recommendation pipeline ALREADY refuses before any draft exists is
// not a gap a person must close: recommendation-gates.js drops/blocks it with templateDrivenBodyBlock (a page
// that only hands a data object to a shared component has no markup an HTML edit can be located in). The audit
// used to count these as fatal and sent people to hand-place markers that would never be used (Admizz: 123 of
// the 196 rows). Same function, same inputs as the gate, so the two cannot drift. Adapter-routed rows never
// reach this list. Anything the gate does NOT block stays fatal.
function partitionPreDraftBlocked(rows, fileContentFor) {
  const blocked = [];
  const stillFatal = [];
  for (const row of rows) {
    const content = fileContentFor(row.filePath);
    const reason = typeof content === 'string' ? preDraftContentBlock(content, row.actionType, row.filePath) : null;
    (reason ? blocked : stillFatal).push(reason ? { ...row, blockedReason: reason } : row);
  }
  return { blocked, stillFatal };
}

// One line per classifyNginxMarker() status. Built per status on purpose: an object literal of all four would evaluate the
// `blocked` text (which reads nginx.locations) for every status and throw whenever the marker is present or self-healing.
function describeNginxMarker(nginx) {
  switch (nginx.status) {
    case 'present': return 'present';
    case 'self-heals': return 'marker missing but self-healing (the implementer inserts it into the serving server block at apply time)';
    case 'blocked': return `marker missing; a security-headers draft would be REFUSED (${nginx.reason}): ${(nginx.locations || []).slice(0, 4).join(', ')} set their own add_header, so nginx would not inherit server-level headers there. Not a config gap — restructure those locations first, or leave headers as they are if the required headers are already served`;
    case 'fatal': return `MISSING (fatal: ${nginx.reason} — no serving server { } block to place it in)`;
    default: return `unknown status ${nginx.status}`;
  }
}

// Net-new content types split three ways: configured (has a target), declared not applicable (the site builds that page by hand, with a reason)
// and genuinely unconfigured. Only the last is a coverage gap.
function partitionContentTargets(site, types, newContentTargets) {
  const declared = []; const missing = [];
  for (const t of types) {
    if (newContentTargets[t]) continue;
    const d = resolveNewContentNotApplicable(site, t);
    if (d) declared.push({ type: t, reason: d.reason }); else missing.push(t);
  }
  return { declared, missing };
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return flags;
}

function defaultRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// A `fatal-no-head-region` verdict on `openGraph` means "this file has no
// detectable per-page head region to splice a marker into" — it does NOT
// mean OG tags are actually broken on the live site. Real, opposite cases
// confirmed 2026-09-11 on two shared-layout (Eleventy) sites with the
// identical audit symptom: zunkireelabs.com's base.njk already renders
// correct og:title/og:description automatically from the same title/
// description front matter meta-title manages (curl confirmed; zero
// open-graph drafts have ever failed in the drafts table) — a false
// positive, nothing to fix. chayceproperties.com had zero og:* tags at all
// on the live page — a real gap. Same "fatal" reason, opposite ground
// truth, and nothing about url_file_map's static config can tell them
// apart — only the live page can. This is that check, automated, so a
// future onboarding doesn't have to rediscover the distinction by hand
// (see the action-center-onboarding skill's §7 for the full story).
//
// Deliberately narrow: only ever runs for `openGraph` gaps classified
// `fatal-no-head-region` (the one case this ambiguity applies to), never
// downgrades any other field or reason, and fails closed on any fetch
// error or missing/empty tag — an unverifiable page stays reported fatal,
// same "never guess" discipline as every other check in this script.
const OG_LIVE_CHECK_CONCURRENCY = 4;

// /blog/page/2/ etc. are generated listing pages of one paginated template,
// never a draft target: mapping one to the index file would let a draft
// rewrite the title/description of every page in the series.
const PAGINATION_PATH_RE = /\/page\/\d+\/?$/;

// Quote-aware: an attribute value in "..." may contain an apostrophe (and in '...' a double
// quote) without ending the value — `content="Let's talk"` must read as "Let's talk", not "Let".
// The tag matcher is quote-aware too, so a `>` inside a value cannot cut the tag short. Attribute
// order is irrelevant (content may precede property).
const META_TAG_RE = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR_RE = /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseTagAttrs(tag) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

function decodeBasicEntities(v) {
  return v
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractMetaContent(html, property) {
  const want = String(property).toLowerCase();
  for (const tag of String(html || '').match(META_TAG_RE) || []) {
    const a = parseTagAttrs(tag);
    if ((a.property || '').toLowerCase() !== want) continue;
    const content = decodeBasicEntities(a.content ?? '').trim();
    return content || null;
  }
  return null;
}

// Presence alone is a weak signal — a tag can exist and be non-empty while
// still being placeholder text nobody meant to ship ("TODO", "Lorem ipsum",
// a bare "Untitled"/"Home", or a suspiciously short 1-2 word fragment no
// real og:title/description would be). This is deliberately a narrow,
// high-confidence denylist, not a quality judgment — it exists to catch
// leftover scaffolding text, not to second-guess a short-but-real title. A
// borderline case is left alone rather than flagged; false positives here
// would just retrain a human to ignore this section.
const OG_PLACEHOLDER_RE = /^\s*(todo|tbd|lorem ipsum|placeholder|untitled|coming soon|test|xxx+)\s*$/i;

function looksLikeOgPlaceholder(value) {
  const trimmed = (value || '').trim();
  return OG_PLACEHOLDER_RE.test(trimmed) || trimmed.length < 4;
}

async function verifyLiveOpenGraph(pageUrl, fetch = fetchHtml) {
  const fetched = await fetch(pageUrl);
  if (!fetched.ok) return { ok: false, reason: fetched.error };
  const title = extractMetaContent(fetched.html, 'og:title');
  const description = extractMetaContent(fetched.html, 'og:description');
  if (!title || !description) return { ok: false, reason: `live page missing ${!title ? 'og:title' : 'og:description'}` };
  if (looksLikeOgPlaceholder(title)) return { ok: false, reason: `og:title looks like placeholder text ("${title}"), not real content` };
  if (looksLikeOgPlaceholder(description)) return { ok: false, reason: `og:description looks like placeholder text ("${description}"), not real content` };
  return { ok: true, title, description };
}

// Same idea for canonical: a shared layout that renders
// <link rel="canonical" href="{{ page.url }}"> on every page makes a
// per-page canonical draft redundant. Only counts as verified when the live
// canonical is present AND self-referencing (same path as the page), so a
// canonical pointing at another URL is never waved through as "fine".
function extractCanonicalHref(html) {
  const tag = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html)?.[0];
  return tag ? (/href=["']([^"']*)["']/i.exec(tag)?.[1] || '').trim() || null : null;
}

function normalizePath(u) {
  try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch { return null; }
}

async function verifyLiveCanonical(pageUrl, fetch = fetchHtml) {
  const fetched = await fetch(pageUrl);
  if (!fetched.ok) return { ok: false, reason: fetched.error };
  const href = extractCanonicalHref(fetched.html);
  if (!href) return { ok: false, reason: 'live page has no canonical link' };
  const same = normalizePath(href) !== null && normalizePath(href) === normalizePath(pageUrl);
  if (!same) return { ok: false, reason: `live canonical points elsewhere (${href})` };
  return { ok: true, href };
}

// Batches with bounded concurrency rather than Promise.all on the whole
// list — this can run against 100+ pages on a large site, and courtesy to
// the live target (and this script's own runtime) matters more than
// shaving a few seconds off an on-demand audit.
async function verifyLiveBatch(entries, verify = verifyLiveOpenGraph) {
  const results = new Map();
  let i = 0;
  async function worker() {
    while (i < entries.length) {
      const entry = entries[i++];
      results.set(entry.page, await verify(entry.page));
    }
  }
  await Promise.all(Array.from({ length: Math.min(OG_LIVE_CHECK_CONCURRENCY, entries.length) }, worker));
  return results;
}

// A "fatal-no-head-region" verdict for a HEAD-scoped field (canonical,
// openGraph, any analytics-install provider) on a shared-layout SSG file
// with no literal <head> is CORRECT — a human placing a one-time marker
// there is this codebase's own intended workflow (§2 of the
// action-center-onboarding skill), same as the literal-<head> case. What
// actually costs time is finding WHERE in that file the real head region
// lives, when it isn't a bare <head> tag — e.g. Chayce's `headExtra: |`
// front-matter block-literal, which base.njk injects straight into its own
// real <head> at build time (confirmed 2026-09-11). This is a read-only
// HINT for that investigation step, not a new auto-insertion mechanism —
// deliberately heuristic (a plain regex, not real YAML parsing) since
// nothing here writes anything; a wrong guess only wastes a human's next
// look, never corrupts a file the way a wrong auto-splice would.
function findHeadCandidateFrontMatterFields(fileContent) {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(fileContent);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const candidates = [];
  const blockFieldRe = /^(\w+):\s*\|\s*\r?\n([\s\S]*?)(?=\r?\n\w+:|\r?\n?$)/gm;
  let m;
  while ((m = blockFieldRe.exec(fm))) {
    const [, key, body] = m;
    if (/<link\b|<style\b|<script\b|<meta\b/i.test(body)) candidates.push(key);
  }
  return candidates;
}

// Exported so connect-repo.js can run this same check automatically right
// after url_file_map is set, instead of relying on the operator to remember
// a separate `npm run audit-url-file-map` step (the exact class of gap this
// whole script exists to catch — see the module comment above).
export async function auditSite(siteId, { record = true } = {}) {
  const loaded = await getSiteById(siteId);
  if (!loaded) { console.log(`Site #${siteId}: not found — skipping.`); return; }
  const areas = listAreas(loaded);
  if (!areas.length) return auditSiteObject(loaded, siteId, { record });
  // A site with areas is audited area by area, each against its own map and files, and the stored gap count is the total across areas.
  let total = 0;
  for (const area of areas) {
    console.log(`\n########## AREA "${area.name}" (${(area.include || []).join(', ') || 'rest of the domain'}${(area.exclude || []).length ? `, excluding ${area.exclude.join(', ')}` : ''}) ##########`);
    const gaps = await auditSiteObject(siteForArea(loaded, area.name), siteId, { record: false });
    if (typeof gaps === 'number') total += gaps;
  }
  console.log(`\nSite #${siteId} total across ${areas.length} areas: ${total} gap(s).`);
  if (record) await recordActionCenterConfigCheck(siteId, total);
  else console.log('(--no-record: the stored action-center gap count and checked-at were NOT updated.)');
  return total;
}

async function auditSiteObject(site, siteId, { record = true } = {}) {
  if (!site.repo_owner || !site.repo_name) {
    console.log(`Site #${siteId} "${site.name}": no repo configured yet — skipping (nothing to audit against).`);
    return;
  }

  // Credential check FIRST, before anything else this audit does — every
  // section below makes its own authenticated GitHub calls and silently
  // degrades a dead credential into a wall of "file not found"/"could not
  // check" noise (getFileContent swallows the error into `false`/warnings
  // per-path, since a genuinely missing file has to look the same as one
  // this audit couldn't read). A human onboarding a site, or an agent about
  // to start generating recommendations for it, needs this as one clear
  // PASS/FAIL up front, not inferred from which of thirty file checks
  // happened to fail. Real incident, site 8864 (2026-09-11): 18
  // recommendations sat blocked on "GitHub credentials are missing or no
  // longer valid" without this ever being checked as its own first step.
  let credentialsOk = false;
  try {
    await getDefaultBranchSha(site);
    credentialsOk = true;
  } catch (err) {
    console.log(`\n-- GITHUB CREDENTIALS -- FAIL: ${err.message}`);
    console.log('   Every other section below will misreport as missing files/markers until this is fixed — resolve this first, then re-run.');
  }
  if (credentialsOk) console.log('\n-- GITHUB CREDENTIALS -- OK, repo reachable.');

  const { start, end } = defaultRange();
  const rawPages = await getSearchPerformanceRange(siteId, start, end, 'page', PAGE_LIMIT);
  // A domain-level GSC property (sc-domain:...) returns pages from every
  // subdomain it has data for, including unrelated products on the same
  // root domain (see agents/lib/site-domain.js) — filtered the same way
  // selectCandidatePages/ai-recommendation.js already do, so this audit's
  // "real candidate pages" pool matches what the actual recommendation
  // agents use, not raw unfiltered GSC data.
  // knownDomain (primary), not ownDomains: candidate-pages.js scans the primary
  // domain only, because a registered additional_own_domain (edgex./zenly.)
  // is a separate product with its own repo and no recommendations here.
  // Auditing it against THIS repo only reported gaps nothing would act on.
  const pages = filterOwnDomainPages(rawPages, knownDomain(site)).filter((p) => !PAGINATION_PATH_RE.test(new URL(p.dim_value).pathname));
  // GSC keeps listing URLs that now 301 elsewhere (renamed/consolidated
  // pages) or 404. Auditing them yields "file not found" / "no file mapping"
  // for pages that no longer exist as pages, so only live (or unverifiable —
  // never assume) URLs are audited. zunkireelabs.com: all 11 "file not found"
  // rows were 301s to a replacement page.
  const gscUrls = pages.map((p) => p.dim_value);
  const { results: probes, skipped: probeSkipped } = await probeMany(gscUrls, { maxProbes: gscUrls.length, concurrency: 4 });
  const goneUrls = probes.filter((r) => r.verdict === 'redirect' || r.verdict === 'dead');
  const goneSet = new Set(goneUrls.map((r) => r.url));
  const pageUrls = gscUrls.filter((u) => !goneSet.has(u));
  if (goneUrls.length) {
    console.log(`(skipped ${goneUrls.length} URL(s) that redirect or 404 — not auditable as pages:)`);
    for (const r of goneUrls) console.log(`  ${r.verdict === 'redirect' ? `${r.status} -> ${r.redirectsTo}` : r.status}  ${r.url}`);
  }
  if (rawPages.length !== pages.length) {
    console.log(`(filtered ${rawPages.length - pages.length} page(s) from other subdomains — own domains: ${(ownDomains(site) || []).join(', ') || '(none configured)'})`);
  }

  console.log(`\n=== Site #${siteId} "${site.name}" (${site.repo_owner}/${site.repo_name}) — ${pageUrls.length} real candidate pages, ${ACTION_TYPES.length} action types ===`);

  let noFileMapping = []; // { page, actionType }
  const noMarkers = Object.fromEntries(ACTION_TYPES.map((t) => [t, []])); // actionType -> [page]
  const adapterRouted = []; // { page, actionType, adapterId }
  const notApplicable = []; // { page, actionType, reason } — declared in url_file_map.notApplicable
  const fileCache = new Map(); // filePath -> { content } | false | 'error'
  const markersToCheck = []; // { page, actionType, filePath, markerField, markerName }

  for (const page of pageUrls) {
    const filePath = resolveFile(site, page);
    // Files this page's actions will really read. resolveActionFile is what the implementer itself
    // uses (backend.js): a mapping may name a DIFFERENT file for one action type — e.g. MOBILISE keeps
    // each page's <head> tags in a heads/*.njk partial via placements[open-graph].file — and checking
    // the page file instead reported a marker as missing from a file the implementer never writes to.
    const filesToRead = new Set(filePath ? [filePath] : []);

    for (const actionType of ACTION_TYPES) {
      // The site's map declares (with a reason) that its own template already provides this action: not a gap, listed under its reason.
      const declared = resolveNotApplicable(site, page, actionType);
      if (declared) { notApplicable.push({ page, actionType, reason: declared.reason }); continue; }
      const adapterConfig = resolveAdapter(site, page, actionType);
      if (adapterConfig) {
        adapterRouted.push({ page, actionType, adapterId: adapterConfig.id });
        continue; // the adapter owns its own file/field validation, not this script's concern
      }

      if (!filePath) {
        noFileMapping.push({ page, actionType });
        continue;
      }

      const markers = resolveMarkers(site, page, actionType);
      if (!markers) { noMarkers[actionType].push(page); continue; }

      const actionFile = fileForAction(site, page, actionType, filePath);
      filesToRead.add(actionFile);
      for (const [markerField, markerName] of Object.entries(markers)) {
        markersToCheck.push({ page, actionType, filePath: actionFile, markerField, markerName });
      }
    }

    // One real, read-only GitHub read per unique file path (cached across
    // pages/action types) — confirms a configured path isn't stale/typo'd,
    // and its real content is what the marker-presence check below runs
    // against, without hammering the API once per (page, actionType) combo.
    for (const readPath of filesToRead) {
      if (fileCache.has(readPath)) continue;
      try {
        const file = await getFileContent(site, readPath, baseBranch(site));
        fileCache.set(readPath, file ? { content: file.content } : false);
      } catch (err) {
        fileCache.set(readPath, 'error');
        console.warn(`  (could not check ${readPath}: ${err.message})`);
      }
    }
  }

  const missingFiles = [...fileCache.entries()].filter(([, v]) => v === false).map(([p]) => p);

  // Real evidence, not config — only meaningful for a file that actually
  // exists and was readable; a missing/errored file is already reported
  // above and would just double-report as "marker missing" too. Split via
  // classifyMarkerGap (marker-merge.js) into what ensureMarkers will fix
  // automatically at apply time vs. what genuinely needs a human anchor —
  // the same classification the implementer itself uses, not a re-guess.
  const markersMissingRaw = markersToCheck.filter(({ filePath, markerName }) => {
    const cached = fileCache.get(filePath);
    return cached && cached !== 'error' && !hasMarker(cached.content, markerName);
  });
  const markersMissing = markersMissingRaw.map((m) => ({
    ...m, gap: classifyMarkerGap(m.markerField, m.filePath, fileCache.get(m.filePath).content, DETECTORS),
  }));
  const markersSelfHealing = markersMissing.filter((m) => m.gap === 'self-heals');
  const fatalCandidates = markersMissing.filter((m) => m.gap !== 'self-heals');
  const { blocked: markersPreDraftBlocked, stillFatal } = partitionPreDraftBlocked(
    fatalCandidates, (path) => { const c = fileCache.get(path); return c && c !== 'error' ? c.content : null; },
  );
  let markersFatal = stillFatal;

  // See verifyLiveOpenGraph's own comment above for why this exists: a
  // `fatal-no-head-region` verdict on openGraph specifically can't be
  // trusted without checking the live page, since a shared layout can
  // legitimately auto-derive OG tags from an already-managed field. One
  // fetch per unique live URL among the candidates, not per (field) row.
  const ogFatalCandidates = markersFatal.filter((m) => m.markerField === 'openGraph' && m.gap === 'fatal-no-head-region');
  const ogLiveVerifiedOk = [];
  if (ogFatalCandidates.length) {
    const uniquePages = [...new Map(ogFatalCandidates.map((m) => [m.page, m])).values()];
    const liveResults = await verifyLiveBatch(uniquePages, verifyLiveOpenGraph);
    markersFatal = markersFatal.filter((m) => {
      if (!(m.markerField === 'openGraph' && m.gap === 'fatal-no-head-region')) return true;
      const result = liveResults.get(m.page);
      if (result?.ok) { ogLiveVerifiedOk.push({ ...m, live: result }); return false; }
      return true; // fetch failed or tags missing/empty — stays reported fatal, never guessed clean
    });
  }

  // An unmapped page is only a real gap if the live page is actually
  // missing the tag. canonical/open-graph are routinely rendered by the
  // shared layout for every page (zunkireelabs.com: all of /locations,
  // /glossary, /compare), so "no file mapping" there is noise, not a defect.
  // Same fail-closed rule as the OG check above: any fetch error or missing
  // tag keeps the entry reported.
  const unmappedLiveVerified = [];
  const liveCheckers = { 'open-graph': verifyLiveOpenGraph, canonical: verifyLiveCanonical };
  for (const [actionType, verify] of Object.entries(liveCheckers)) {
    const entries = noFileMapping.filter((e) => e.actionType === actionType);
    if (!entries.length) continue;
    const results = await verifyLiveBatch([...new Map(entries.map((e) => [e.page, e])).values()], verify);
    noFileMapping = noFileMapping.filter((e) => {
      if (e.actionType !== actionType) return true;
      if (results.get(e.page)?.ok) { unmappedLiveVerified.push(e); return false; }
      return true;
    });
  }

  const naByReason = new Map();
  for (const r of notApplicable) { if (!naByReason.has(r.reason)) naByReason.set(r.reason, []); naByReason.get(r.reason).push(r); }
  console.log(`\n-- DECLARED NOT APPLICABLE in url_file_map.notApplicable (${notApplicable.length} rows) -- (not gaps: the site's own template provides the action; each declaration carries its reason)`);
  for (const [reason, rows] of naByReason) {
    console.log(`  ${rows.length} row(s) on ${new Set(rows.map((r) => r.page)).size} page(s) [${[...new Set(rows.map((r) => r.actionType))].join(', ')}]: ${reason}`);
  }

  console.log(`\n-- NO FILE MAPPING (${noFileMapping.length}) --`);
  for (const { page, actionType } of noFileMapping) console.log(`  [${actionType}] ${page}`);

  console.log(`\n-- UNMAPPED BUT LIVE-VERIFIED OK, not a gap (${unmappedLiveVerified.length}) -- (no file mapping, but the live page already renders a correct canonical / og:title+og:description — shared layout handles it)`);
  for (const { page, actionType } of unmappedLiveVerified) console.log(`  [${actionType}] ${page}`);

  for (const actionType of ACTION_TYPES) {
    console.log(`\n-- NO MARKERS CONFIGURED (${actionType}) (${noMarkers[actionType].length}) --`);
    for (const page of noMarkers[actionType]) console.log(`  ${page}`);
  }

  console.log(`\n-- FILE NOT FOUND IN REPO (${missingFiles.length}) --`);
  for (const filePath of missingFiles) console.log(`  ${filePath}`);

  console.log(`\n-- MARKERS MISSING BUT SELF-HEALING (ensureMarkers creates these automatically at apply time — no action needed) (${markersSelfHealing.length}) --`);
  for (const { page, actionType, filePath, markerField, markerName } of markersSelfHealing) {
    console.log(`  [${actionType}:${markerField}] ${page} -> ${filePath} (will auto-create SEOAI:${markerName})`);
  }

  console.log(`\n-- OPEN GRAPH LIVE-VERIFIED OK, not fatal (${ogLiveVerifiedOk.length}) -- (no per-page marker exists, but the live page already has correct og:title/og:description — likely auto-derived by the shared layout; nothing to fix)`);
  for (const { page, filePath } of ogLiveVerifiedOk) {
    console.log(`  ${page} -> ${filePath}`);
  }

  console.log(`\n-- MARKERS MISSING, BUT ALREADY BLOCKED BEFORE ANY DRAFT (${markersPreDraftBlocked.length} rows in ${new Set(markersPreDraftBlocked.map((m) => m.filePath)).size} file(s)) -- (unsupported by design: the page only hands a data object to a shared component, so recommendation-gates.js refuses these actions up front. Not a gap to hand-fix; a marker here would never be used)`);
  const blockedByFile = new Map();
  for (const m of markersPreDraftBlocked) {
    if (!blockedByFile.has(m.filePath)) blockedByFile.set(m.filePath, new Set());
    blockedByFile.get(m.filePath).add(m.actionType);
  }
  for (const [filePath, types] of blockedByFile) console.log(`  ${filePath} [${[...types].join(', ')}]`);

  console.log(`\n-- MARKERS MISSING, FATAL (need a one-time human-placed anchor before any draft for this field can apply) (${markersFatal.length}) --`);
  const headCandidateCache = new Map(); // filePath -> field names, computed once per file
  for (const { page, actionType, filePath, markerField, markerName, gap } of markersFatal) {
    let hint = '';
    if (gap === 'fatal-no-head-region' && isHeadScopedField(markerField)) {
      if (!headCandidateCache.has(filePath)) {
        const cached = fileCache.get(filePath);
        headCandidateCache.set(filePath, cached && cached !== 'error' ? findHeadCandidateFrontMatterFields(cached.content) : []);
      }
      const candidates = headCandidateCache.get(filePath);
      if (candidates.length) hint = ` — possible head region: front-matter field(s) "${candidates.join('", "')}" (verify then place the SEOAI:HEAD marker inside, see onboarding skill §2/§7)`;
    }
    console.log(`  [${actionType}:${markerField}] ${page} -> ${filePath} (expected SEOAI:${markerName}, reason: ${gap})${hint}`);
  }

  console.log(`\n-- ADAPTER-ROUTED, not deep-checked here (${adapterRouted.length}) --`);
  const byAdapter = adapterRouted.reduce((acc, r) => { (acc[r.adapterId] ||= []).push(`[${r.actionType}] ${r.page}`); return acc; }, {});
  for (const [adapterId, entries] of Object.entries(byAdapter)) {
    console.log(`  ${adapterId}: ${entries.length} page/type combination(s)`);
  }

  // Rendering Validation Gate completeness (lib/rendering-gate.js) — every
  // newContentTargets entry (landing-page, blog-outline, direct-answer,
  // translation, legal/compliance pages, and any future net-new-content
  // generator) writes a fresh Markdown body via newpage-render.js, which
  // the real gate blocks at apply time unless url_file_map.renderCapabilities
  // proves that target's extension actually gets Markdown-processed. Checked
  // here too, at onboarding-audit time, using the exact same resolution
  // (resolveCapability) the real gate uses — so this class of gap is caught
  // BEFORE a staff member approves a draft that can never actually apply,
  // the same principle every other section of this audit already follows.
  const newContentTargets = site.url_file_map?.newContentTargets || {};
  const renderCapabilityGaps = []; // { actionType, extension, reason }
  for (const [actionType, target] of Object.entries(newContentTargets)) {
    if (!target?.extension) continue;
    if (targetRendersCode(actionType, target)) continue; // code renderer: the Markdown gate never applies (see targetRendersCode)
    const syntheticPath = `${target.dir || ''}/example${target.extension}`;
    const { caps, capability } = resolveCapability(site, { path: syntheticPath, actionType });
    if (!caps) {
      renderCapabilityGaps.push({ actionType, extension: extensionOf(syntheticPath), reason: 'no-render-capabilities-configured' });
    } else if (!capability) {
      renderCapabilityGaps.push({ actionType, extension: extensionOf(syntheticPath), reason: 'extension-not-recorded' });
    } else if (!capability.markdown) {
      renderCapabilityGaps.push({ actionType, extension: extensionOf(syntheticPath), reason: 'recorded-not-markdown-safe' });
    }
  }
  console.log(`\n-- RENDER CAPABILITY GAPS (${renderCapabilityGaps.length}) -- (net-new pages this site can generate but the gate will block at apply time)`);
  for (const { actionType, extension, reason } of renderCapabilityGaps) {
    console.log(`  [${actionType}] extension "${extension}" — ${reason}`);
  }
  if (Object.keys(newContentTargets).length && !renderCapabilityGaps.length) {
    console.log('  OK — every configured newContentTargets extension has a recorded, markdown-safe renderCapabilities entry.');
  }

  // Coverage, not correctness: which net-new content types this site has NO
  // target for at all. Not fatal by design — a site may genuinely never need
  // e.g. translation — but it must be a visible, explicit choice made once
  // at onboarding ("configure it now, or accept these will block later"),
  // not a gap nobody looked at until a recommendation for it showed up
  // blocked. See NEW_CONTENT_ACTION_TYPES above for the real incident this
  // closes.
  const { declared: declaredContentTypes, missing: missingContentTargets } = partitionContentTargets(site, NEW_CONTENT_ACTION_TYPES, newContentTargets);
  console.log(`\n-- NEW CONTENT TARGETS NOT CONFIGURED (${missingContentTargets.length}/${NEW_CONTENT_ACTION_TYPES.length}) -- (not fatal; any recommendation of this type will block until configured)`);
  for (const actionType of missingContentTargets) console.log(`  [${actionType}] no url_file_map.newContentTargets["${actionType}"] entry`);
  if (!missingContentTargets.length) console.log(declaredContentTypes.length ? '  OK — every known net-new content type has a target or a declared reason.' : '  OK — every known net-new content type has a target configured.');
  if (declaredContentTypes.length) {
    console.log(`\n-- DECLARED NOT APPLICABLE: net-new content built by hand (${declaredContentTypes.length}) -- (not gaps; each declaration carries its reason)`);
    for (const d of declaredContentTypes) console.log(`  [${d.type}] ${d.reason}`);
  }

  // Author/org avatar aspect-ratio check (avatar-aspect-check.js) — catches
  // the zunkireelabs-web incident shape (a wide wordmark logo declared as
  // rendering inside a circular object-cover avatar frame, which crops it
  // to an unrecognizable sliver) at onboarding time, before any blog post
  // ships. Purely config-driven: a site with no siteRoot.authorAvatars
  // declared has nothing to check here, same as every other optional
  // section of this audit.
  const authorAvatars = resolveAuthorAvatars(site);
  const avatarAspectFatal = []; // { label, imagePath, reason }
  const avatarAspectUnverified = []; // { label, imagePath, reason }
  for (const avatar of authorAvatars) {
    if (!avatar?.imagePath) continue;
    let dimensions = null;
    try {
      const file = await getFileContent(site, avatar.imagePath, baseBranch(site));
      if (!file) {
        avatarAspectFatal.push({ label: avatar.label, imagePath: avatar.imagePath, reason: 'file not found in repo' });
        continue;
      }
      if (avatar.imagePath.toLowerCase().endsWith('.svg')) dimensions = parseSvgDimensions(file.content);
    } catch (err) {
      console.warn(`  (could not check avatar ${avatar.imagePath}: ${err.message})`);
      continue;
    }
    const gap = classifyAvatarAspectGap({ expectedFit: avatar.expectedFit, dimensions });
    if (!gap) continue;
    const entry = { label: avatar.label, imagePath: avatar.imagePath, reason: gap.reason };
    if (gap.severity === 'fatal') avatarAspectFatal.push(entry);
    else avatarAspectUnverified.push(entry);
  }
  console.log(`\n-- AUTHOR AVATAR ASPECT-RATIO GAPS (${avatarAspectFatal.length}) -- (a non-square logo/avatar declared as rendering inside a circular crop frame)`);
  for (const { label, imagePath, reason } of avatarAspectFatal) console.log(`  ${label || imagePath} (${imagePath}): ${reason}`);
  if (avatarAspectUnverified.length) {
    console.log(`\n-- AUTHOR AVATAR ASPECT-RATIO, UNVERIFIED (${avatarAspectUnverified.length}) -- (declared circular-cover but this audit can't determine real dimensions — check by eye)`);
    for (const { label, imagePath, reason } of avatarAspectUnverified) console.log(`  ${label || imagePath} (${imagePath}): ${reason}`);
  }
  if (authorAvatars.length && !avatarAspectFatal.length && !avatarAspectUnverified.length) {
    console.log('  OK — every declared circular-cover avatar is square enough to survive the crop.');
  }

  // Dedicated nginx security-headers marker check — a site-root marker, not
  // per-page, and the one marker type that can NEVER auto-create itself
  // (see the module comment above), so it gets checked and named explicitly
  // instead of folding into the generic per-page counts above.
  const nginxPath = resolveSiteRootFile(site, 'nginxConfig');
  let nginxMarkerOk = null; // null = not configured, so nothing to check
  if (nginxPath) {
    try {
      const file = await getFileContent(site, nginxPath, baseBranch(site));
      // nginx uses `#`-comment markers, not marker-merge.js's `<!-- -->`
      // convention (see backend.js's applySecurityHeaders/hash-marker-merge.js)
      // — hasMarker() here always reports MISSING even when the real,
      // apply-path-relevant marker is present.
      const nginx = file ? classifyNginxMarker(file.content) : { status: 'fatal', reason: 'file-not-found' };
      // Only a marker the engine genuinely cannot place counts as a gap. `self-heals` is created at apply
      // time; `blocked` is an intentional safety refusal (reported loudly, but nothing to configure).
      nginxMarkerOk = nginx.status === 'fatal' ? false : true;
      const line = describeNginxMarker(nginx);
      console.log(`\n-- NGINX SECURITY-HEADERS MARKER (${nginxPath}) -- ${line}`);
    } catch (err) {
      console.warn(`\n-- NGINX SECURITY-HEADERS MARKER (${nginxPath}) -- could not check: ${err.message}`);
    }
  } else {
    console.log('\n-- NGINX SECURITY-HEADERS MARKER -- url_file_map.siteRoot.nginxConfig not configured, skipping.');
  }

  // Dedicated analytics-install check — sitewide (layoutTemplate + a single
  // defaults.placements entry), not per-page; see the ACTION_TYPES comment
  // above for why this can't just be another entry in that loop.
  const layoutPath = resolveSiteRootFile(site, 'layoutTemplate');
  let analyticsInstallGap = null; // null = nothing to report
  let existingTracking = null;
  try {
    existingTracking = summarizeExistingTracking(await scanRepoForTracking(site, [defaultBranchName(site), prTargetBranchName(site)]));
  } catch { existingTracking = null; } // an unreadable repo never counts as "already installed"
  if (existingTracking) {
    console.log(`\n-- ANALYTICS-INSTALL (sitewide) -- NOT APPLICABLE: the repository already loads Google tracking (${existingTracking.files.join(', ')}${existingTracking.ga4.length ? `; GA4 ${existingTracking.ga4.join(', ')}` : ''}${existingTracking.gtm.length ? `; GTM ${existingTracking.gtm.join(', ')}` : ''}). A second install would double-count and could bypass consent; an analytics-install recommendation is dismissed by the duplicate guard, so no install marker is needed.`);
  } else if (!layoutPath) {
    analyticsInstallGap = 'no-file-mapping';
    console.log('\n-- ANALYTICS-INSTALL (sitewide) -- url_file_map.siteRoot.layoutTemplate not configured (fatal — needed before this can ever apply).');
  } else {
    // Each provider (ga4/facebook-pixel) has its own field/marker — see
    // ANALYTICS_PROVIDER_FIELDS (marker-merge.js) — so both can be
    // configured and applied without one clobbering the other's marker.
    // This checks whatever's actually configured; a provider whose field
    // isn't in analyticsMarkers yet just won't be able to apply, same as
    // "no markers configured" below, one provider at a time.
    const analyticsMarkers = resolveMarkers(site, null, 'analytics-install');
    if (!analyticsMarkers) {
      analyticsInstallGap = 'no-markers-configured';
      console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- no markers configured (add e.g. {"analyticsScriptGa4":"ANALYTICSSCRIPTGA4","analyticsScriptFacebookPixel":"ANALYTICSSCRIPTFACEBOOKPIXEL"} to url_file_map.defaults.placements["analytics-install"].markers — configure whichever provider(s) you actually use).`);
    } else {
      try {
        const file = await getFileContent(site, layoutPath, baseBranch(site));
        if (!file) {
          analyticsInstallGap = 'file-not-found';
          console.log(`\n-- ANALYTICS-INSTALL (sitewide) -- ${layoutPath} not found in repo.`);
        } else {
          const missing = Object.entries(analyticsMarkers).filter(([, name]) => !hasMarker(file.content, name));
          if (!missing.length) {
            console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- OK, marker(s) present.`);
          } else {
            const [field, markerName] = missing[0];
            const gap = classifyMarkerGap(field, layoutPath, file.content, DETECTORS);
            if (gap === 'self-heals') {
              console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- marker missing but self-healing (will auto-create SEOAI:${markerName} at apply time).`);
            } else {
              analyticsInstallGap = gap;
              console.log(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- marker missing, FATAL (expected SEOAI:${markerName}, reason: ${gap}).`);
            }
          }
        }
      } catch (err) {
        console.warn(`\n-- ANALYTICS-INSTALL (sitewide, ${layoutPath}) -- could not check: ${err.message}`);
      }
    }
  }

  const clean = credentialsOk && noFileMapping.length === 0 && missingFiles.length === 0 && markersFatal.length === 0
    && nginxMarkerOk !== false && analyticsInstallGap === null && renderCapabilityGaps.length === 0
    && avatarAspectFatal.length === 0
    && ACTION_TYPES.every((t) => noMarkers[t].length === 0);
  console.log(`\nSite #${siteId}: ${clean ? 'CLEAN — no gaps found.' : 'gaps found — see above.'}`);

  const gapCount = noFileMapping.length + missingFiles.length + markersFatal.length
    + (nginxMarkerOk === false ? 1 : 0)
    + (analyticsInstallGap !== null ? 1 : 0)
    + renderCapabilityGaps.length
    + avatarAspectFatal.length
    + ACTION_TYPES.reduce((sum, t) => sum + noMarkers[t].length, 0);
  // A read-only run (--no-record) must leave the stored gap count and checked-at untouched: a partial or
  // credential-less run would otherwise overwrite the last real audit with a misleading number.
  if (record) await recordActionCenterConfigCheck(siteId, gapCount);
  else console.log('(--no-record: the stored action-center gap count and checked-at were NOT updated.)');
  return gapCount;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.all) {
    console.error('--all is not implemented yet — pass --site-id <id> for now. (listConnectedSites() is already imported and ready for when this is wired up.)');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  if (!flags['site-id']) {
    console.error('Usage: node server/scripts/audit-url-file-map.js --site-id <id>  (or --all, not yet implemented)');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const siteIds = [Number(flags['site-id'])];

  // agent_fix_memory rows (migration 097) recorded with no generator_id are
  // structural/architectural gotchas learned from real past fixes (e.g.
  // "a page pattern may already get its schema/content computed by the
  // site's own template at build time — check before wiring a generator
  // adapter for it") rather than a single generator's prompt mistake.
  // Surfacing them here, at onboarding-audit time, is what lets a new
  // client's config get checked against issues already hit once before —
  // instead of re-discovering the same class of gap from scratch.
  for (const id of siteIds) {
    const lessons = await findRelevantMemory({ scope: 'client', siteId: id, generatorId: null, clientFacing: true, limit: 20 });
    if (lessons.length) {
      console.log(`\nKnown issues to check for site #${id} (from past fixes):`);
      for (const l of lessons) console.log(`  - ${l.problemSignature}: ${l.symptoms}`);
    }
  }

  for (const id of siteIds) await auditSite(id, { record: flags['no-record'] !== true });

  await pool.end();
}

// Guarded like discover-url-file-map.js/bootstrap-structural-markers.js's
// own CLI entrypoints — connect-repo.js imports auditSite() as a library
// call, and without this guard that import alone re-ran this file's own
// CLI main() (parsing connect-repo's argv, auditing, and calling
// pool.end()) as a side effect, before connect-repo's own explicit
// auditSite() call and pool.end() ran — hence "Called end on pool more
// than once".
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export const __testables = { partitionContentTargets, describeNginxMarker, partitionPreDraftBlocked, targetRendersCode, classifyNginxMarker, summarizeExistingTracking, fileForAction, looksLikeOgPlaceholder, verifyLiveOpenGraph, verifyLiveCanonical, extractMetaContent };
