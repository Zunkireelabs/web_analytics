import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';

// Pure, deterministic generator — no LLM call. og:title/og:description are
// grounded directly in the page's own real, already-fetched title/meta
// description (or a real body excerpt as fallback) — never fabricated
// copy. The implementer (server/implementers/backend.js) splices this into
// the page's own template via the head-scoped marker mechanism
// (server/implementers/lib/marker-merge.js's HEAD_SCOPED_FIELDS).

export const meta = {
  id: 'open-graph',
  name: 'Open Graph Tags Generator',
  description: 'Drafts og:title/og:description and matching Twitter Card tags, grounded in the real page title and description.',
  recommendationTags: [],
};

const PLACEHOLDER_NOTE = '[NEEDS INPUT — not verifiable from real site data]';
const EXCERPT_LEN = 160;
// 'summary_large_image' is the safe universal default (Twitter/X falls back
// to 'summary' automatically if no image ends up configured) — there's no
// image-selection pipeline here to pick a real og:image/twitter:image from,
// so this only ever drafts the text fields, same as og:title/og:description.
const TWITTER_CARD_TYPE = 'summary_large_image';

// params: { page: string }
export async function generate({ params }) {
  const { page } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });

  // The recommendation that led here is only ever generated from a PAST
  // audit fetch — this page's live state can have changed since (a
  // shared-layout fix that started emitting og:title/og:description for
  // every page from title/description front matter, a manual template fix,
  // ...). Re-checking live rather than trusting the finding avoids drafting
  // (and getting permanently stuck on, if no per-page marker was ever
  // configured for tags the page never actually needed) a fix for a gap
  // that's already closed. Same "stale: true" pattern as schema.js's/
  // canonical.js's own already-fixed refusal — auto-remediation.js closes
  // the recommendation on sight instead of leaving it open to be
  // re-attempted and re-refused forever.
  if (fetched.analysis.hasOpenGraph) {
    throw Object.assign(
      new Error(`"${page}" already has Open Graph tags — drafting another would duplicate them, not fix a gap.`),
      { status: 400, userFacing: true, refusal: true, stale: true },
    );
  }

  const { title, metaDescription, bodyText } = fetched.analysis;
  const ogTitle = title || PLACEHOLDER_NOTE;
  // A thin/boilerplate-only extraction must fall through to the placeholder,
  // same as an empty bodyText already did — otherwise a real meta
  // description gap on a nav-heavy page would silently ship nav/footer text
  // as the og:description instead of flagging it for manual input.
  const ogDescription = metaDescription || (hasSufficientGroundingContent(fetched.analysis) ? bodyText.slice(0, EXCERPT_LEN) : PLACEHOLDER_NOTE);

  // Same placeholderFields contract as schema.js's PLACEHOLDER_NOTE fields —
  // marker-merge.js's buildMergeValues blocks publishing while any are
  // present, so a page with no real title/description can never ship the
  // literal placeholder string as a live og:title/og:description on the
  // "safe" tier's zero-review auto-publish path.
  const placeholderFields = [];
  if (ogTitle === PLACEHOLDER_NOTE) placeholderFields.push('ogTitle');
  if (ogDescription === PLACEHOLDER_NOTE) placeholderFields.push('ogDescription');

  // Twitter Card tags deterministically mirror the same real title/
  // description — no second grounding decision to make, no separate
  // placeholder logic: whatever ogTitle/ogDescription resolved to (real
  // content or the placeholder) is exactly right for these too.
  return {
    content: {
      page, ogTitle, ogDescription, placeholderFields,
      twitterCard: TWITTER_CARD_TYPE, twitterTitle: ogTitle, twitterDescription: ogDescription,
    },
    summary: `Open Graph + Twitter Card tags for ${page}`,
  };
}
