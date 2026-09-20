import { analyzePageUrl, requireGroundedContent } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { sanitizeTable } from './expand-content.js';

// Distinct from expand-content.js: expand-content only ever ADDS new
// subtopics the page has never covered. This generator's job is the
// opposite direction the multi-tenant growth spec calls out separately —
// a page that used to perform and is now declining usually needs its
// EXISTING claims corrected/updated, not a brand-new section bolted on.
// Reuses expand-content's real merge path (marker-merge.js's 'expand-content'
// actionType / expandedContent field) deliberately: every onboarded site's
// real page template already has that marker wired up (see the
// action-center-onboarding skill), and introducing a second content marker
// would mean re-onboarding every site before this could ever ship. What's
// genuinely different here is the PROMPT and the visible framing (an
// "Updated" section, freshness-stamped), not the applied HTML slot.
export const meta = {
  id: 'refresh-content',
  name: 'Content Refresh Generator',
  description: 'Drafts an update to an existing page whose real performance is declining — grounded only in the page\'s own current text plus the real GSC click/position trend that flagged it, never guessed.',
  recommendationTags: ['content-refresh', 'freshness-date'],
};

const SYSTEM_REFRESH = 'You are a content strategist. A page\'s real search performance has declined (clicks and/or ranking ' +
  'position dropped — see the real numbers given). Given the page\'s current real body text, draft ONE update section that ' +
  'a returning visitor or search engine would read as the page catching up: correct anything in the given text that reads ' +
  'as outdated, add current context, or sharpen the parts most likely to have gone stale. Ground every sentence ONLY in the ' +
  'page text and the real decline numbers given — never invent a new fact, price, feature, or date not present in either. ' +
  'If nothing in the given text looks outdated, write a section that reinforces the page\'s strongest existing claim with ' +
  'more depth instead of inventing a "what changed" narrative that isn\'t there. ' +
  'Respond with ONLY a JSON array of exactly one item: [{"heading": "...", "body": "..."}]';

// params: { page: string, query?: string, trend?: { priorClicks, recentClicks, priorPosition, recentPosition, dropPct } }
export async function generate({ siteId, params }) {
  const { page, query, trend } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400, userFacing: true });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400, userFacing: true });
  requireGroundedContent(fetched.analysis, { generatorId: meta.id });

  const trendLine = trend
    ? `Real decline evidence: clicks went from ${trend.priorClicks} to ${trend.recentClicks} (${trend.dropPct}% drop)` +
      (trend.priorPosition != null && trend.recentPosition != null
        ? `, average position moved from #${Number(trend.priorPosition).toFixed(1)} to #${Number(trend.recentPosition).toFixed(1)}.`
        : '.')
    : 'Real decline evidence: this page\'s clicks dropped meaningfully versus the prior period (exact figures unavailable).';

  const user = `Query: ${query || ''}\n${trendLine}\nPage title: ${fetched.analysis.title}\nPage text: ${fetched.analysis.bodyText.slice(0, 3000)}`;

  let sections;
  try {
    sections = await callLLMForJson(SYSTEM_REFRESH, user, {
      maxTokens: 500, generatorId: meta.id, siteId, validate: Array.isArray,
    });
  } catch {
    throw Object.assign(new Error('Content refresh failed: model did not return valid JSON'), { status: 400, userFacing: true });
  }
  sections = sections
    .filter((s) => s && typeof s.heading === 'string' && typeof s.body === 'string')
    .slice(0, 1)
    .map((s) => ({ ...s, table: sanitizeTable(s.table) }));

  if (!sections.length) {
    throw Object.assign(new Error('Content refresh produced no usable section — the model returned an empty result or nothing matched the expected shape.'), { status: 400, userFacing: true, refusal: true, reason: 'refresh-content-empty-sections' });
  }

  // No appended visible "Last Updated" section: that stamp used to be tacked
  // on here alongside the real update, but a bolted-on "Last Updated: <date>"
  // heading is exactly the kind of unstyled, bolted-on-looking block CLAUDE.md's
  // design-preservation rule exists to prevent — confirmed live on site 8864
  // (chayceproperties.com, 2026-09-20), where it shipped as an unclassed <h1>
  // on 6+ pages alongside real comparison content. The real, honest freshness
  // fact (today's date) belongs in dateModified schema (see geo-signals.js's
  // freshness-date rule, now routed to the 'schema' generator), not as a
  // second visible section a human never asked to see on the page.
  const content = { page, sections, focus: 'content-refresh' };
  return { content, summary: `Refreshed 1 section for ${page} (real click/position decline)` };
}
