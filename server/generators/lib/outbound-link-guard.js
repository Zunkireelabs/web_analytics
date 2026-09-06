import { collectStrings } from './placeholder-guard.js';
import { getCompetitorDomainSet, normalizeHost } from '../../agents/lib/competitor-policy.js';

// Final, deterministic safety net: whatever a generator's prompt did or
// didn't say, this catches an outbound link to one of THIS site's own
// configured competitors before a draft can ship. Wired into
// runQualityGate below as an always-on check (like placeholder-guard's
// checkPlaceholders) — every generator gets it automatically, and a future
// generator that produces outbound links is covered without any new
// per-generator wiring.
//
// Scope: this catches a LINKED competitor mention — the actual pattern found
// live (zunkireelabs.com/blog/top-tech-companies-nepal-2026/ linked
// f1soft.com/verisk.com/logpoint.com/paailatechnology.com, each with its own
// "**Website**:" link). An unlinked competitor mention is NOT this guard's
// job and is no longer unguarded: competitor-prominence.js now measures
// whether a competitor headlines or dominates the page, deriving each
// competitor's display name from its configured domain label. The two are
// deliberately separate checks — this one is about link authority leaving the
// site, that one is about who the page is about.
//
// Note what this does not do: it does not ban naming a competitor. Comparison
// content that names competitors, weighs their capabilities, and argues why
// the client is the better fit is a wanted capability. What is blocked is the
// dofollow link that hands a competitor ranking authority from the client's
// own domain — a comparison can make its case without one.

const MARKDOWN_LINK = /\[[^\]\n]{1,200}\]\((https?:\/\/[^\s)]+)\)/g;
const RAW_URL = /https?:\/\/[^\s)"'<>]+/g;

// Every URL found in one string, WITHOUT double-counting a URL that's
// already inside a markdown link's parens (the raw-URL pass runs on the
// string with markdown-link spans blanked out first).
function extractUrlsFromString(text) {
  const urls = [];
  let markdownFree = text;
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    urls.push(match[1]);
    markdownFree = markdownFree.replace(match[0], ' '.repeat(match[0].length));
  }
  for (const match of markdownFree.matchAll(RAW_URL)) urls.push(match[0]);
  return urls;
}

/**
 * @returns {Array<{path: string, url: string}>} every outbound link found
 * anywhere in the content tree, table cells included (same walk as
 * placeholder-guard.js's checkPlaceholders, for the same reason: the
 * original fabricated-competitor incident lived entirely inside a
 * structured `table` field no prose-only check would see).
 */
export function extractOutboundLinks(content) {
  const links = [];
  for (const { path, text } of collectStrings(content)) {
    for (const url of extractUrlsFromString(text)) links.push({ path, url });
  }
  return links;
}

/**
 * @returns {{issues: Array<{path, patternId, snippet, detail}>}} in the same
 * shape every sibling guard returns to runQualityGate. siteId is required —
 * with none given (a generator that never receives one), this is a no-op,
 * never a false-positive block or a lookup against the wrong tenant.
 */
export async function findCompetitorLinks(content, siteId) {
  if (!siteId) return { issues: [] };
  const links = extractOutboundLinks(content);
  if (!links.length) return { issues: [] };
  const domains = await getCompetitorDomainSet(siteId);
  if (!domains.size) return { issues: [] };

  const issues = [];
  for (const { path, url } of links) {
    const host = normalizeHost(url);
    if (!host) continue;
    const matchedDomain = [...domains].find((d) => host === d || host.endsWith(`.${d}`));
    if (!matchedDomain) continue;
    issues.push({
      path,
      patternId: 'competitor-link',
      snippet: url.slice(0, 120),
      detail: `Generated content links to ${matchedDomain}, a domain configured as a competitor for this site. Remove the link/mention or rewrite this section without promoting a real competitor — do not link to a competitor unless the content is an explicit, intentional comparison.`,
    });
  }
  return { issues };
}
