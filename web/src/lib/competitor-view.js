// Turns the already-persisted competitor data into what the Competitors page shows: for each
// competitor, in which ways it is ahead of this site and in which this site leads. Pure, no
// fetching. A measure with no real data for a competitor is left out of its count entirely, never
// guessed, so "ahead on 2 of 3" always means three measures were actually compared.

export const normDomain = (d) => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

const SOURCE_LABEL = {
  both: 'Found on Google and by AI research',
  serp: 'Found on Google',
  llm: 'Found by AI research',
  forced: 'Added by you',
};

const ratio = (a, b) => (b > 0 ? a / b : null);

export function buildCompetitorView({ competitors = [], backlinkComparison = null, rankingComparison = null } = {}) {
  const own = backlinkComparison?.ownDomain || null;
  const linkByDomain = new Map((backlinkComparison?.competitors || []).map((c) => [normDomain(c.domain), c]));
  const rankingRows = rankingComparison?.checked ? (rankingComparison.rows || []) : null;

  const cards = competitors.map((p) => {
    const domain = normDomain(p.domain);
    const cmp = p.comparison || {};
    const measures = [];

    const link = linkByDomain.get(domain);
    if (own && link && own.referringDomains != null && link.referringDomains != null) {
      const ahead = link.referringDomains > own.referringDomains;
      const x = ratio(link.referringDomains, own.referringDomains);
      measures.push({
        key: 'links', label: 'Sites linking to them', hint: 'Other websites pointing to them',
        you: own.referringDomains, them: link.referringDomains, unit: 'count', ahead,
        detail: ahead ? (x && own.referringDomains > 0 ? `${x >= 10 ? Math.round(x) : x.toFixed(1)}x as many` : `${link.referringDomains - own.referringDomains} more`) : 'you have more',
      });
    }

    if (cmp.ownScore != null && cmp.competitorScore != null) {
      const diff = cmp.competitorScore - cmp.ownScore;
      measures.push({
        key: 'content', label: 'Helpful content', hint: 'How easy their pages are to read and quote',
        you: cmp.ownScore, them: cmp.competitorScore, unit: 'percent', ahead: diff > 0,
        detail: diff > 0 ? `${diff} point${diff === 1 ? '' : 's'} better` : diff < 0 ? `you are ${-diff} point${diff === -1 ? '' : 's'} better` : 'level',
      });
    }

    let searches = [];
    if (rankingRows) {
      searches = rankingRows.filter((r) => normDomain(r.competitorDomain) === domain)
        .sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
      measures.push({
        key: 'searches', label: 'Searches they show above you on', hint: 'Real Google searches',
        you: null, them: searches.length, unit: 'searches', ahead: searches.length > 0,
        detail: searches.length ? `${searches.length} search${searches.length === 1 ? '' : 'es'}` : 'none',
      });
    }

    const aheadN = measures.filter((m) => m.ahead).length;
    return {
      id: p.id,
      domain,
      source: SOURCE_LABEL[cmp.discoverySource] || null,
      note: cmp.verdict || cmp.positioning || null,
      measures,
      searches: searches.map((r) => ({ query: r.query, theirPosition: r.competitorPosition, yourPosition: r.ownPosition })),
      aheadN,
      total: measures.length,
      // Ahead of you if it leads on more measures than you do.
      leadsYou: measures.length > 0 && aheadN > measures.length - aheadN,
    };
  });

  // Most threatening first: the ones ahead on the most measures.
  cards.sort((a, b) => (b.aheadN - a.aheadN) || (b.total - a.total) || a.domain.localeCompare(b.domain));

  const strongest = backlinkComparison?.strongestProfile;
  const largestGap = backlinkComparison?.largestGap || null;
  const ownScore = competitors.find((p) => p.comparison?.ownScore != null)?.comparison?.ownScore ?? null;
  const scored = competitors.filter((p) => p.comparison?.competitorScore != null && p.comparison?.ownScore != null);
  const contentBeaten = scored.filter((p) => p.comparison.ownScore > p.comparison.competitorScore).length;

  return {
    cards,
    aheadCount: cards.filter((c) => c.leadsYou).length,
    total: cards.length,
    ownLinks: own?.referringDomains ?? null,
    largestGap: largestGap && { domain: normDomain(largestGap.domain), gap: largestGap.gap, theirs: (own?.referringDomains ?? 0) + largestGap.gap },
    strongestIsOwn: !!strongest && !!own && normDomain(strongest.domain) === normDomain(own.domain),
    ownScore,
    contentBeaten,
    contentCompared: scored.length,
  };
}

// The plain-words paragraph: only sentences the data backs.
export function buildStory(view) {
  if (!view.total) return null;
  const parts = [];
  parts.push(view.aheadCount === 0
    ? `None of your ${view.total} competitors is ahead of you on most of what we measure.`
    : `${view.aheadCount} of your ${view.total} competitors ${view.aheadCount === 1 ? 'is' : 'are'} ahead of you on most of what we measure.`);
  if (view.largestGap) {
    parts.push(`The biggest gap is links: ${view.largestGap.domain} has ${view.largestGap.theirs.toLocaleString('en-US')} other websites pointing to it, and you have ${(view.ownLinks ?? 0).toLocaleString('en-US')}.`);
  } else if (view.ownLinks != null && view.strongestIsOwn) {
    parts.push('You have more websites linking to you than any competitor we track.');
  }
  if (view.contentCompared > 0) {
    if (view.contentBeaten * 2 > view.contentCompared) parts.push('Your pages are easier to read and quote than most of theirs, and that is your edge.');
    else if (view.contentBeaten * 2 < view.contentCompared) parts.push('Most competitors\' pages are easier to read and quote than yours, which is worth fixing.');
  }
  return parts.join(' ');
}
