import { fileURLToPath } from 'url';
import path from 'path';
import { riskTierForGenerator } from '../agents/lib/risk-tiers.js';

// Queues the owner-approved AI-visibility fixes as ordinary open recommendations, so the daily agent drafts them like any other
// fix: through the normal generator, the design check, a PR, and a person's merge. Nothing here edits a site.
//
// The fixes (found by reading each live page on 2026-11-23, owner-approved):
//   Chayce    home       title ends "| Chayce" while the business, page header and schema say "Chayce Properties"
//   Zennly    home       title and description are just "Zennly": nothing says what it is or where
//   MOBILISE  about-us   the page has no meta description
//   SuperRank home       AI tools find a misspelling, "Suparank", and a stale directory listing: say they are the same product
//   Zennly    blog post  Nuad Thai Spa, written only from the confirmed facts (a human reads the draft before anything publishes)
//
// Not here, because no generator changes a single fact in place: Zunkiree's "Team: 15+" and location line in the
// top-tech-companies-nepal-2026 post (EN and DE) is a one-line edit made in that repository's own PR.
//
// DRY-RUN BY DEFAULT: prints what it would add and writes nothing unless --apply is passed. Idempotent: a page that already has an
// open recommendation of that type is left alone. Writing to the production database needs a person's explicit OK.
//
//   node server/scripts/seed-visibility-recommendations.js            dry run
//   node server/scripts/seed-visibility-recommendations.js --apply

export const AGENT = 'ai-visibility';
export const ITEMS = [
  {
    siteId: 8864, type: 'meta-title', issue: 'Improve title', page: 'https://chayceproperties.com/', params: { query: 'chayce properties' },
    reason: 'The page title ends "| Chayce" but the business, the page header and the structured data all say "Chayce Properties". AI assistants cannot connect the two names. Use "Chayce Properties" in the title (keep the Northampton elderly removals wording).',
  },
  {
    siteId: 8872, type: 'meta-title', issue: 'Improve title', page: 'https://zennly.io/', params: { query: 'zennly' },
    reason: 'The title and the meta description are both just "Zennly", so nothing tells a search engine or an AI assistant what it is. Zennly is booking and operations software for spas, salons and wellness studios in Nepal.',
  },
  {
    siteId: 8874, type: 'meta-title', issue: 'Improve title', page: 'https://mobilise.agency/about-us/', params: { query: 'mobilise b2b marketing agency' },
    reason: 'The About page has no meta description. MOBILISE is a global B2B marketing agency headquartered in Bangalore, with teams in Singapore, the Middle East and North America, serving enterprise brands across APAC, EMEA and the Americas.',
  },
  {
    siteId: 8871, type: 'faq', issue: 'Add an answer AI assistants can quote', page: 'https://superrank.si/', params: { query: 'suparank', topic: 'Is SuperRank the same as Suparank?' },
    reason: 'AI assistants and directories show SuperRank under a misspelling, "Suparank", with an out-of-date price and check count. Add one visible FAQ answer saying SuperRank and Suparank are the same product, with the real figures: 40+ checks per page, plans from $95/mo.',
  },
  {
    siteId: 8872, type: 'blog-outline', issue: 'New post: Nuad Thai Spa on Zennly', page: 'https://zennly.io/blog/nuad-thai-spa',
    // Stricter than the platform default for a blog post: it is about a real customer and only a few facts are confirmed, so a
    // person approves it in the Action Center before anything is drafted.
    riskTier: 'manual',
    params: {
      topic: 'How Nuad Thai Spa in Lazimpat, Kathmandu uses Zennly',
      context: 'Use only these confirmed facts: Zennly is booking and operations software for spas, salons and wellness studios in Nepal, built by Zunkiree Labs; Nuad Thai Spa (Lazimpat, Kathmandu) is a customer and may be named. Do NOT state branch, therapist or service counts, results, prices, or any quote: none are confirmed. A person reads the draft before it publishes.',
    },
    reason: 'Zennly has one named customer and no page about it, so AI assistants have nothing to cite. Write a short post on Nuad Thai Spa using Zennly, only from the confirmed facts.',
  },
];

// The recommendation row for one item. Pure, so it is testable without a database.
export function buildRecommendation(item) {
  return {
    page: item.page,
    recommendationType: item.type,
    issue: item.issue,
    reason: item.reason,
    params: { page: item.page, ...item.params },
    findingId: `${AGENT}:${item.type}:${item.page}`,
    detectingAgent: AGENT,
    priority: 'high',
    expectedImpact: { basis: 'owner-priority', label: 'High', value: 10 },
    // The platform's own rule for the generator, unless an item asks for a STRICTER tier (never a looser one).
    riskTier: item.riskTier === 'manual' ? 'manual' : riskTierForGenerator(item.type),
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { findOpenRecommendation, insertRecommendation } = await import('../store/recommendations.js');
  for (const item of ITEMS) {
    const rec = buildRecommendation(item);
    const open = await findOpenRecommendation(item.siteId, item.page, item.type);
    console.log(`\nSite ${item.siteId}  ${item.type}  ${item.page}  [${rec.riskTier}]\n  ${rec.reason}`);
    if (open) { console.log(`  -> already open as recommendation ${open.id}; left alone`); continue; }
    if (!apply) { console.log('  -> would add (dry run)'); continue; }
    const row = await insertRecommendation(item.siteId, rec);
    console.log(`  -> added as recommendation ${row.id}`);
  }
  if (!apply) console.log('\nDry run: nothing was written. Re-run with --apply after the owner approves.');
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e.message); process.exit(1); });
