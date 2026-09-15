import { createHash } from 'crypto';
import { getSearchPerformanceForPages, getSiteById } from '../store/read.js';
import { priorityByRank, impactFromPriority, makeFinding, effortFromDifficulty } from './lib/findings.js';
import { analyzePageUrl } from './lib/page-content.js';
import { selectCandidatePages, markPagesChecked } from './lib/candidate-pages.js';
import { updatePageContentHashBatch, listContentHashesForSite } from '../store/page-inventory.js';
import { evidenceWindow, fetchTraffic, decideWinner, EVIDENCE_LOOKBACK_DAYS } from './lib/duplicate-evidence.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'duplicate-content',
  name: 'Duplicate Content Agent',
  description: 'Finds pages whose full body content is byte-identical to another page on the site — the same content reachable at two different URLs, a real, common crawl-budget and ranking-dilution problem.',
  category: 'seo',
  version: 1,
};

const MAX_PAGES = 20;
// Below this word count, an exact-hash match is more likely two genuinely
// thin/near-empty pages (e.g. both mostly boilerplate) than real duplicate
// content worth flagging — same MIN_WORD_COUNT threshold page-content.js's
// own contentGapChecks() uses for "Expand content."
const MIN_WORDS_FOR_HASH = 300;

// SHA-256 of the page's full real fetched body text (already whitespace-
// normalized by analyzePage). Deliberately exact, not fuzzy/similarity-based
// — shared nav/header/footer boilerplate across a site's own template does
// NOT cause a false match here, since the hash only collides when the
// ENTIRE body (boilerplate AND main content) is byte-identical, which in
// practice means the same content really is being served at two URLs
// (pagination artifacts, trailing-slash/query-param variants, printer-
// friendly duplicates, staging leftovers) — not just "similar-looking pages."
function hashContent(bodyText) {
  return createHash('sha256').update(bodyText).digest('hex');
}

export async function run({ siteId, start, end, pageCache, params }) {
  const { batch, impressionsByPage } = params?.pages?.length
    ? await getSearchPerformanceForPages(siteId, start, end, params.pages).then((rows) => ({
      batch: params.pages,
      impressionsByPage: new Map(rows.map((r) => [r.dim_value, Number(r.impressions)])),
    }))
    : await selectCandidatePages(siteId, 'duplicate-content', { start, end, batchSize: MAX_PAGES });

  if (!batch.length) {
    return {
      meta, status: 'insufficient-data', facts: null, narrative: null,
      message: 'No page performance data yet to select pages from.',
      generatedAt: new Date().toISOString(),
    };
  }

  const fetchPage = pageCache || analyzePageUrl;
  const fetched = await Promise.all(batch.map(async (page) => ({ page, result: await fetchPage(page) })));
  if (!params?.pages?.length) await markPagesChecked(siteId, 'duplicate-content', batch);

  // Only pages with real, substantial content get hashed — thin pages are
  // excluded from the comparison pool entirely (never recorded with a hash
  // that could coincidentally match another thin page).
  const hashByPage = new Map();
  for (const { page, result } of fetched) {
    if (!result.ok || result.analysis.wordCount < MIN_WORDS_FOR_HASH) continue;
    hashByPage.set(page, hashContent(result.analysis.bodyText));
  }
  if (hashByPage.size) await updatePageContentHashBatch(siteId, hashByPage);

  // Compares against the site's own real accumulated coverage (every page
  // ever hashed by a past run, not just today's rotation batch) — same
  // "merge today's fresh data with everything already known" pattern
  // technical-seo.js's detectDuplicateTitles already uses for titles.
  const known = await listContentHashesForSite(siteId);
  const byHash = new Map();
  for (const { page, content_hash: hash } of known) {
    if (!byHash.has(hash)) byHash.set(hash, new Set());
    byHash.get(hash).add(page);
  }
  for (const [page, hash] of hashByPage) {
    if (!byHash.has(hash)) byHash.set(hash, new Set());
    byHash.get(hash).add(page);
  }

  const duplicateGroups = [...byHash.entries()]
    .filter(([, pages]) => pages.size >= 2)
    .map(([hash, pages]) => ({ hash, pages: [...pages] }));

  // A duplicate-content group is not a live problem if every member already
  // carries a <link rel="canonical"> pointing at ONE consistent target —
  // search engines already know which URL to index, so flagging it (or
  // blocking it for a human "which URL should win" decision) would ask a
  // question the site has already answered itself. The target does not have
  // to be a member of this byte-hash group itself (a group can legitimately
  // form from only the parameterized variants, with the bare canonical page
  // outside today's hash-matched set) — group membership here is about
  // detection coverage, not about where the true canonical lives. Confirmed
  // real on zunkireelabs.com 2026-09-12: /resources/?type=X and
  // /contact/?source=X query-string variants all already emit a
  // self-resolving canonical to the bare URL via the shared Eleventy
  // template — the common case for tracking-parameter variants, not a
  // hypothetical. Reuses this run's own fetches (analysisByPage) where
  // available; a group member outside today's rotation batch gets one extra
  // live fetch, since canonical resolution isn't derivable from the stored
  // content_hash alone.
  const analysisByPage = new Map(fetched.filter((f) => f.result.ok).map((f) => [f.page, f.result.analysis]));
  async function groupAlreadyCanonicalized(pages) {
    const targets = new Set();
    for (const page of pages) {
      let analysis = analysisByPage.get(page);
      if (!analysis) {
        const result = await fetchPage(page);
        if (!result.ok) return false; // can't confirm resolution without a live read — leave it open
        analysis = result.analysis;
        analysisByPage.set(page, analysis);
      }
      if (!analysis.hasCanonical || !analysis.canonicalUrl) return false; // nothing decided yet
      targets.add(analysis.canonicalUrl.replace(/\/$/, ''));
    }
    return targets.size === 1; // every member agrees on one real target
  }
  const unresolvedGroups = [];
  for (const group of duplicateGroups) {
    if (await groupAlreadyCanonicalized(group.pages)) continue;
    unresolvedGroups.push(group);
  }

  const sumImpressions = (pages) => pages.reduce((s, p) => s + (impressionsByPage.get(p) || 0), 0);
  const rankedGroups = [...unresolvedGroups].sort((a, b) => sumImpressions(b.pages) - sumImpressions(a.pages));
  const priorities = priorityByRank(rankedGroups);

  // Evidence-based winner decision — same shared model url-variant-duplicates.js,
  // query-param-duplicates.js and templated-duplicates.js already use for
  // "which of these competing URLs is the real one": HIGH confidence only
  // when exactly one page has any real 90-day clicks/impressions and the
  // rest have none, or when 2+ pages each earn real traffic AND every pair's
  // real search queries overlap substantially (confirming shared search
  // intent, not just shared bytes). That query-overlap escalation is what
  // was missing until now — it's a genuinely independent signal from raw
  // impressions, and is exactly the kind of editorial-intent evidence the
  // comment below used to say didn't exist. Still never auto-decides on
  // impressions alone (MEDIUM/LOW stays a human reportOnly decision, same
  // as before) — see decideWinner's own doc comment for the exact bar.
  const site = await getSiteById(siteId);
  const { start: evidenceStart, end: evidenceEnd } = evidenceWindow(site);
  const allGroupPages = rankedGroups.flatMap((g) => g.pages);
  const trafficByPage = new Map(
    (await fetchTraffic(siteId, allGroupPages, evidenceStart, evidenceEnd)).map((t) => [t.page, t])
  );
  const decisionByHash = new Map();
  for (const g of rankedGroups) {
    const traffic = g.pages.map((p) => trafficByPage.get(p) || { page: p, clicks: 0, impressions: 0 });
    decisionByHash.set(g.hash, await decideWinner(traffic, { siteId, start: evidenceStart, end: evidenceEnd }));
  }

  const findings = rankedGroups.map((g, i) => {
    const decision = decisionByHash.get(g.hash);
    if (decision.winner) {
      const losers = g.pages.filter((p) => p !== decision.winner.page);
      return makeFinding({
        id: `duplicate-content:hash:${g.hash}`,
        evidence: { pages: [...g.pages].sort(), pageCount: g.pages.length, contentHash: g.hash, traffic: decision.withTraffic, winner: decision.winner.page, confidence: 'high', queryOverlap: decision.queryOverlap },
        whyItMatters: decision.queryOverlap?.overlapping
          ? `${g.pages.length} pages have byte-identical body content at different URLs — ${decision.winner.page} earns more real clicks (${decision.winner.clicks}) than the other(s), and their real search queries overlap substantially, confirming they compete for the same search intent. Confident enough to consolidate automatically.`
          : `${g.pages.length} pages have byte-identical body content at different URLs — ${decision.winner.page} has all ${decision.winner.clicks} real click(s)/${decision.winner.impressions} impression(s) across the last ${EVIDENCE_LOOKBACK_DAYS} days, and the other page(s) have none. Confident enough to consolidate automatically: the losing page(s) get a canonical tag pointing at the real one.`,
        priority: priorities[i],
        // Same safe canonical generator every self-referential canonical
        // fix already uses — one loser per recommendation (mirrors
        // url-variant-duplicates.js), since each is its own separate
        // page/file/PR target. The generator re-verifies the target is
        // still live and refuses rather than guess if anything changed
        // since this evidence was gathered. Still ends at a human-reviewed
        // PR — autonomy here means zero manual investigation to REACH that
        // PR, not a bypass of the merge step.
        recommendedAction: {
          label: `Canonicalize duplicate content → ${decision.winner.page}`,
          generatorId: 'canonical',
          params: { page: losers[0], canonicalTarget: decision.winner.page },
          effort: effortFromDifficulty(1),
        },
        expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'computed', value: decision.winner.clicks || sumImpressions(g.pages) },
      });
    }
    return makeFinding({
      // Keyed on the CONTENT HASH the group is defined by, not on a member
      // page. The id used to be the alphabetically-first page in the group,
      // which made it unstable under exactly the change this agent exists to
      // detect: discovering a third URL serving the same content could sort
      // ahead of the previous anchor, so the same unresolved duplication
      // re-appeared under a brand-new id — a "new" finding in Action Center,
      // a broken match against the already-open recommendation, and a lost
      // history. The hash is what makes these pages one group, so it is the
      // group's identity: adding or removing a member never changes it, and
      // two genuinely different duplicate groups can never collide because
      // different body content is exactly what a different hash means.
      id: `duplicate-content:hash:${g.hash}`,
      // Sorted so the same group renders identically run to run regardless of
      // the order pages happened to come back from the inventory query.
      evidence: { pages: [...g.pages].sort(), pageCount: g.pages.length, contentHash: g.hash, traffic: decision.withTraffic, confidence: decision.confidence, queryOverlap: decision.queryOverlap },
      whyItMatters: `${g.pages.length} pages have byte-identical body content — the same content is reachable at ${g.pages.length} different URLs, which splits ranking signals and wastes crawl budget instead of consolidating them onto one real page.`,
      priority: priorities[i],
      recommendedAction: null, // no evidenced winner yet — see decideWinner's HIGH-confidence bar above
      // Deliberately NOT auto-canonicalized when the evidence doesn't clear
      // decideWinner's HIGH bar (exactly one page with real traffic, or
      // substantial cross-page query overlap confirming shared intent).
      // Choosing which URL owns the content decides which page keeps its
      // ranking — pointing that at the wrong page is a traffic loss no
      // later fix recovers cheaply, so with split/no traffic evidence this
      // stays a human decision, same as every sibling duplicate detector.
      // Until 2026-09-09 this finding had a null action and no reportOnly,
      // which meant buildRecommendations dropped it outright: byte-identical
      // duplicate pages were detected on every run and shown to nobody.
      reportOnly: {
        kind: 'duplicate-content',
        label: `${g.pages.length} URLs serve identical content`,
        page: [...g.pages].sort()[0],
        whyBlocked: decision.withTraffic.length > 1
          ? 'These URLs serve byte-identical content and more than one of them earns real search traffic with no confirmed shared search intent — picking one to consolidate the rest onto would risk redirecting a page that\'s still earning its own real clicks, so it needs a person who knows which page is the intended one.'
          : 'These URLs serve byte-identical content, but no real search traffic points to a clear winner yet. Consolidating them means choosing which single URL should own this content — that decision changes which page keeps its search ranking, so it needs a person who knows which page is the intended one.',
      },
      expectedImpact: { label: impactFromPriority(priorities[i]), basis: 'computed', value: sumImpressions(g.pages) },
    });
  });

  const facts = {
    rangeStart: start, rangeEnd: end,
    batchSize: batch.length,
    pagesHashedThisRun: hashByPage.size,
    totalPagesTracked: known.length + hashByPage.size, // approximate — known already excludes this run's fresh hashes until persisted, so this is real coverage right after this run's writes land
    findings,
  };

  const system = 'You are a technical SEO specialist writing for a non-technical site owner. Given real groups of ' +
    'pages whose content is byte-identical (found via hashing, not guessed), write 2-3 sentences naming the ' +
    'group with the most real search traffic and recommend picking one canonical URL for that content. Use ONLY ' +
    'the pages/data given, never invent a page not present in the facts. Plain text, no markdown, no bullets.';
  const narrative = findings.length
    ? await callLLM(system, `Facts: ${JSON.stringify(facts)}`, { maxTokens: 250 })
      .catch((err) => { console.warn('[agents] duplicate-content narrative failed:', err.message); return null; })
    : null;

  return { meta, status: 'ok', facts, narrative, generatedAt: new Date().toISOString() };
}
