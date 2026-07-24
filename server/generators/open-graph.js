import { analyzePageUrl } from '../agents/lib/page-content.js';

// Pure, deterministic generator — no LLM call. og:title/og:description are
// grounded directly in the page's own real, already-fetched title/meta
// description (or a real body excerpt as fallback) — never fabricated
// copy. The implementer (server/implementers/backend.js) splices this into
// the page's own template via the head-scoped marker mechanism
// (server/implementers/lib/marker-merge.js's HEAD_SCOPED_FIELDS).

export const meta = {
  id: 'open-graph',
  name: 'Open Graph Tags Generator',
  description: 'Drafts og:title/og:description grounded in the real page title and description.',
  recommendationTags: [],
};

const PLACEHOLDER_NOTE = '[NEEDS INPUT — not verifiable from real site data]';
const EXCERPT_LEN = 160;

// params: { page: string }
export async function generate({ params }) {
  const { page } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });

  const { title, metaDescription, bodyText } = fetched.analysis;
  const ogTitle = title || PLACEHOLDER_NOTE;
  const ogDescription = metaDescription || (bodyText ? bodyText.slice(0, EXCERPT_LEN) : PLACEHOLDER_NOTE);

  return {
    content: { page, ogTitle, ogDescription },
    summary: `Open Graph tags for ${page}`,
  };
}
