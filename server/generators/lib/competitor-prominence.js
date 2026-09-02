import { collectStrings } from './placeholder-guard.js';
import { getCompetitorDomainSet } from '../../agents/lib/competitor-policy.js';
import { ownDomains } from '../../agents/lib/site-domain.js';
import { getSiteById } from '../../store/read.js';

// The second half of the competitor policy, alongside outbound-link-guard.js.
//
// That guard answers "did we LINK a competitor" (authority leakage). This one
// answers the question it deliberately left open: "is a competitor the actual
// SUBJECT of this page" (topical/brand leakage). Both failure modes were found
// live on the same tenant:
//
//   - top-tech-companies-nepal-2026.md — a 50-company directory in which 40
//     competitors each got their own dofollow "**Website**:" link, on a page
//     targeting the client's own head keywords. Competitor mentions 26 vs 7
//     for the client's own brand.
//   - top-it-companies-to-work-for-in-nepal-... — no links at all, so the
//     link guard saw nothing, yet three competitors each got a full flattering
//     `##` section and the client got one. 14 mentions vs 6.
//
// What this does NOT do is ban competitor mentions. Comparison content is a
// deliberate, wanted capability: naming a competitor, comparing capabilities,
// and arguing why the client is the better fit for a use case is exactly the
// content this platform should be able to write. The line this draws is
// domination, not mention — a competitor may appear, but it may not outweigh
// the client's own brand, headline the page, or turn the article into a
// competitor directory.
//
// Name matching without a names column: competitor_profiles stores domains
// only, so each competitor's display name is derived from its domain label
// and matched against the content with separators removed — "paailatechnology"
// matches "Paaila Technology", "f1soft" matches "F1Soft International",
// "logpoint" matches "LogPoint". This avoids both a schema migration and the
// fuzzy free-text matcher the original guard's comment (correctly) refused to
// write: it only ever matches a label that a configured competitor domain
// actually produced.

// A label shorter than this is too likely to collide with ordinary prose once
// separators are stripped, so it is skipped rather than risk a false block.
const MIN_LABEL_LENGTH = 5;

// Distinct competitors named in one article beyond which the piece has stopped
// being a comparison and become a directory of the competition.
const DIRECTORY_THRESHOLD = 5;

// Content paths that carry the page's "what is this about" SEO signals. A
// competitor owning any of these is a different, worse problem than a
// competitor being mentioned in the body, so it is checked separately.
const HEADLINE_PATH = /(^|\.)(title|heading|h1|headline|meta_?title|meta_?description|description|slug|seo_?title)($|\.|\[)/i;

// Markdown H1/H2 lines are headline signals too even when they live inside a
// generic `body`/`content` string rather than a dedicated title field.
const MARKDOWN_HEADING = /^#{1,2}\s+.*$/gm;

// "Paaila Technology" -> "paailatechnology"; lets one derived domain label
// match a display name regardless of spacing, hyphens or casing.
function squash(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// The matchable label a domain implies: its first dot-separated segment, minus
// a leading www. "shkhina-ai-labs.com" -> "shkhinaailabs", "verisk.com" ->
// "verisk". Returns null for anything too short to match safely.
export function domainLabel(domain) {
  const label = squash(String(domain || '').replace(/^www\./, '').split('.')[0]);
  return label.length >= MIN_LABEL_LENGTH ? label : null;
}

function countLabel(squashedText, label) {
  if (!label) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = squashedText.indexOf(label, from);
    if (at === -1) return count;
    count += 1;
    from = at + label.length;
  }
}

// The client's own brand labels: its site name and every domain it owns. Both
// are needed — a post can refer to the brand by name without ever printing the
// domain, which is the normal case.
function brandLabelsFor(site) {
  const labels = new Set();
  const nameLabel = squash(site?.name);
  if (nameLabel.length >= MIN_LABEL_LENGTH) labels.add(nameLabel);
  for (const domain of ownDomains(site) || []) {
    const label = domainLabel(domain);
    if (label) labels.add(label);
  }
  // "Zunkiree Labs" also appears as plain "Zunkiree" far more often than in
  // full, so the leading word of a multi-word site name counts as the brand too.
  const firstWord = squash(String(site?.name || '').trim().split(/\s+/)[0]);
  if (firstWord.length >= MIN_LABEL_LENGTH) labels.add(firstWord);
  return [...labels];
}

// Counts a set of labels across a squashed string, taking the highest single
// label count rather than the sum — "zunkiree" and "zunkireelabs" both match
// the same occurrence of "Zunkiree Labs", and summing would double-count it.
function bestCount(squashedText, labels) {
  let best = 0;
  for (const label of labels) best = Math.max(best, countLabel(squashedText, label));
  return best;
}

/**
 * @returns {{issues: Array<{path, patternId, snippet, detail, blocking}>}} in
 * the same shape every sibling guard returns to runQualityGate. Fails OPEN on
 * a missing siteId, an unresolvable site, or an empty competitor set — the
 * same contract as competitor-policy.js: an infra hiccup or an un-onboarded
 * tenant must never block content generation.
 */
export async function findCompetitorProminenceIssues(content, siteId) {
  if (!siteId) return { issues: [] };

  const domains = await getCompetitorDomainSet(siteId);
  if (!domains.size) return { issues: [] };

  let site = null;
  try {
    site = await getSiteById(siteId);
  } catch (err) {
    console.error(`[competitor-prominence] failed to load site ${siteId}:`, err.message);
    return { issues: [] };
  }
  const brandLabels = brandLabelsFor(site);
  // With no resolvable brand label there is nothing to measure prominence
  // against, and every ratio check below would read as "competitor wins".
  if (!brandLabels.length) return { issues: [] };

  const competitors = [];
  for (const domain of domains) {
    const label = domainLabel(domain);
    if (label) competitors.push({ domain, label });
  }
  if (!competitors.length) return { issues: [] };

  const strings = collectStrings(content);

  let headlineText = '';
  let bodyText = '';
  for (const { path, text } of strings) {
    bodyText += ` ${text}`;
    if (HEADLINE_PATH.test(path)) headlineText += ` ${text}`;
    for (const heading of text.match(MARKDOWN_HEADING) || []) headlineText += ` ${heading}`;
  }

  const squashedBody = squash(bodyText);
  const squashedHeadline = squash(headlineText);

  const brandBodyCount = bestCount(squashedBody, brandLabels);
  const brandHeadlineCount = bestCount(squashedHeadline, brandLabels);

  const named = [];
  let competitorBodyTotal = 0;
  for (const { domain, label } of competitors) {
    const bodyCount = countLabel(squashedBody, label);
    if (!bodyCount) continue;
    competitorBodyTotal += bodyCount;
    named.push({ domain, label, bodyCount, headlineCount: countLabel(squashedHeadline, label) });
  }
  if (!named.length) return { issues: [] };

  const issues = [];

  // 1. A competitor owns the page's headline signals while the client's own
  //    brand is absent from them — the page tells a search engine it is about
  //    the competitor. Worst of the three, and independent of body counts.
  const inHeadline = named.filter((n) => n.headlineCount > 0);
  if (inHeadline.length && brandHeadlineCount === 0) {
    issues.push({
      path: 'content',
      patternId: 'competitor-headline',
      snippet: inHeadline.map((n) => n.domain).join(', ').slice(0, 120),
      detail:
        `The title/H1/meta of this draft names ${inHeadline.map((n) => n.domain).join(', ')} ` +
        'without naming this site\'s own brand. Those fields decide what a search engine thinks the page ' +
        'is about, so a competitor must never own them alone. Rewrite the title/H1/meta around the client ' +
        'and its own positioning — a competitor may still be compared in the body.',
    });
  }

  // 2. Competitors outweigh the client's own brand in the body. Comparison
  //    content is fine; a page where the competition is discussed more than the
  //    client is a page working for the competition.
  if (competitorBodyTotal > brandBodyCount) {
    issues.push({
      path: 'content',
      patternId: 'competitor-outweighs-brand',
      snippet: named.map((n) => `${n.domain} x${n.bodyCount}`).join(', ').slice(0, 120),
      detail:
        `Competitors are mentioned ${competitorBodyTotal} time(s) against ${brandBodyCount} mention(s) of ` +
        'this site\'s own brand, so the competition — not the client — is the substantive subject of the ' +
        'article. Keep the comparison, but rebalance it: lead with the client, make the client\'s own ' +
        'capability the through-line, and cut competitor description down to what the comparison actually needs.',
    });
  }

  // 3. A directory of the competition. Past the threshold this is no longer a
  //    comparison against one or two named alternatives; it is a roundup that
  //    ranks the client alongside everyone it competes with, on the client's
  //    own domain and usually on its own head keywords.
  if (named.length >= DIRECTORY_THRESHOLD) {
    issues.push({
      path: 'content',
      patternId: 'competitor-directory',
      snippet: named.map((n) => n.domain).join(', ').slice(0, 120),
      detail:
        `This draft profiles ${named.length} different configured competitors (${named.map((n) => n.domain).join(', ')}). ` +
        'A listicle/directory of the competition published on the client\'s own domain promotes every company ' +
        'in it and dilutes the client\'s claim to the keyword. Narrow it to a focused comparison against the ' +
        'one or two alternatives the reader is actually choosing between, with the client as the recommendation.',
    });
  }

  return { issues };
}
