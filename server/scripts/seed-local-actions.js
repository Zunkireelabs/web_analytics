// Dev tool: fill ONE project in the LOCAL dev database with Action Center and Content data at every stage, so each screen can be
// checked by eye: open issues, drafts waiting for approval, an approved one, pull requests in review, and a history of fixes and
// content that went live. Everything is tagged `local-demo-actions` so `--remove` takes it out again. It REFUSES to run unless
// DATABASE_URL points at this machine. The pull request links are made up and go nowhere.
//   DATABASE_URL=postgres://...@localhost:55432/analytics DB_SSL=off node server/scripts/seed-local-actions.js --site 1 [--remove]
import { pool } from '../db.js';
import { insertRecommendation } from '../store/recommendations.js';

const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1'].includes(host)) { console.error(`Refusing to run: DATABASE_URL host is "${host || 'unset'}", not this machine.`); process.exit(1); }
const siteId = Number(process.argv[process.argv.indexOf('--site') + 1]);
if (!siteId) { console.error('Usage: --site <site id> [--remove]'); process.exit(1); }
const TAG = 'local-demo-actions';
const q = (sql, p) => pool.query(sql, p);
const ago = (days, hour = 9) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - days); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

if (process.argv.includes('--remove')) {
  await q(`DELETE FROM drafts WHERE site_id=$1 AND finding_origin=$2`, [siteId, TAG]);
  await q(`DELETE FROM recommendations WHERE site_id=$1 AND detecting_agents @> ARRAY[$2]::text[]`, [siteId, TAG]);
  console.log('Removed the Action Center and Content demo data for site', siteId);
  await pool.end(); process.exit(0);
}
const { rows: [site] } = await q('SELECT id, name FROM sites WHERE id=$1', [siteId]);
if (!site) { console.error(`No site ${siteId}`); process.exit(1); }
await q(`DELETE FROM drafts WHERE site_id=$1 AND finding_origin=$2`, [siteId, TAG]);
await q(`DELETE FROM recommendations WHERE site_id=$1 AND detecting_agents @> ARRAY[$2]::text[]`, [siteId, TAG]);

// ---- open issues the agents found (the Action Center "Open" tab)
const issues = [
  ['/blog/salon-management-software/', 'meta-title', 'Title is 74 characters; Google cuts it at about 60', 'high', 'safe'],
  ['/blog/spa-management-software/', 'faq', 'No questions and answers on a page buyers search for', 'high', 'safe'],
  ['/blog/gym-membership-management/', 'schema', 'Page has no structured data for search and AI engines', 'medium', 'safe'],
  ['/pricing/', 'internal-links', 'Pricing page is not linked from 6 related posts', 'medium', 'manual'],
  ['/about/', 'open-graph', 'No social preview image when shared', 'low', 'safe'],
  ['/blog/walk-in-queue-management/', 'html-lang', 'Page language is not declared', 'low', 'safe'],
];
// Content ideas for the Ideas tab: one landing page and one blog post the agent found worth writing. Each shows its options drawn in the
// demo client's own design (the picture comes from the site's recorded design, see below), ready to pick.
const ideas = [
  ['/walk-in-salons/', 'landing-page', 'Software for walk-in salons', 'AI engines are asked about this and the site has no page for it.', { page: '/walk-in-salons/', topic: 'Software for walk-in salons' }],
  ['/blog/compare-salon-management-systems/', 'blog-outline', 'Compare salon management systems', 'Buyers compare tools before choosing, and the site has no comparison.', { page: '/blog/compare-salon-management-systems/', topic: 'Compare salon management systems' }],
];
let n = 0;
for (const [page, type, issue, priority, riskTier] of issues) {
  n += 1;
  await insertRecommendation(siteId, { page, recommendationType: type, issue, reason: 'Found by the daily check.', params: { page }, findingId: `${TAG}-rec-${n}`, detectingAgent: TAG, priority, riskTier, confidence: 0.82 });
}
for (const [page, type, issue, reason, params] of ideas) {
  n += 1;
  await insertRecommendation(siteId, { page, recommendationType: type, issue, reason, params, findingId: `${TAG}-rec-${n}`, detectingAgent: TAG, priority: 'medium', riskTier: 'manual', confidence: 0.8 });
}

// ---- drafts at every stage
const sections = (...h) => h.map(([heading, body]) => ({ heading, body }));
const C = {
  'meta-title': (a, b) => ({ titles: [a, b], selectedTitle: null, metaDescription: 'Run bookings, staff and payments in one place. See how salon owners save 10 hours a week.' }),
  faq: () => ({ items: [
    { question: 'How much does spa management software cost?', answer: 'Most plans run from $29 to $149 a month, depending on staff count and features.' },
    { question: 'Can it handle online booking and reminders?', answer: 'Yes. Clients book online and get automatic SMS and email reminders.' },
    { question: 'Does it work for a single-chair spa?', answer: 'Yes. Solo practitioners use the same booking and payments tools.' },
    { question: 'How long does setup take?', answer: 'Most spas are running the same day.' }] }),
  schema: () => ({ jsonLd: { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Zennly', applicationCategory: 'BusinessApplication' }, placeholderFields: [] }),
  'internal-links': () => ({ suggestedInternalLinks: [{ fromPage: '/blog/salon-management-software/', anchor: 'salon pricing', toPage: '/pricing/' }, { fromPage: '/blog/spa-management-software/', anchor: 'see plans', toPage: '/pricing/' }] }),
  'open-graph': () => ({ title: 'Zennly: salon and spa software', description: 'Bookings, staff and payments in one place.', image: '/images/social-card.png' }),
  'html-lang': () => ({ lang: 'en' }),
  'blog-outline': (title) => ({ title, metaDescription: 'How reminders and a small deposit help a salon keep its chairs full.',
    sections: sections(['Why no-shows hurt a salon', 'A missed appointment leaves a chair empty and costs the salon income it cannot get back.'], ['Send reminders people actually read', 'A text the day before, and a short nudge on the day, gives clients an easy way to confirm or move their booking.'], ['Ask for a small deposit on longer services', 'A deposit on colour and treatments makes a booking feel firm, so clients turn up or change the time early.'], ['Choose software that does this for you', 'Look for automatic reminders, deposits and a link clients can use to reschedule themselves.']),
    suggestedFaqTopics: ['Do reminders really reduce no-shows?', 'How much should a deposit be?'], suggestedInternalLinks: [{ anchor: 'booking app features', url: '/features/booking/' }] }),
  'landing-page': (headline) => ({ headline, subheadline: 'A live queue, text alerts when it is their turn, and no app for clients to install.',
    sections: sections(['Live queue', 'See who is next at a glance on the front-desk screen.'], ['Text alerts', 'Clients get a message when it is their turn.'], ['No app needed', 'Works from a link or QR code.']), cta: 'Start free', metaTitle: headline, metaDescription: 'Queue management built for barbershops and walk-in salons.' }),
  translation: () => ({ targetLanguage: 'Nepali', translatedTitle: 'सैलुन व्यवस्थापन सफ्टवेयर: बुकिङ, कर्मचारी र भुक्तानी', translatedMetaDescription: 'बुकिङ, कर्मचारी र भुक्तानी एकै ठाउँमा चलाउनुहोस्।',
    sourceContent: 'Salon management software helps you run bookings, staff and payments in one place.', translatedContent: 'सैलुन व्यवस्थापन सफ्टवेयरले बुकिङ, कर्मचारी र भुक्तानी एकै ठाउँमा चलाउन मद्दत गर्छ।' }),
};
const prUrl = (n) => `https://github.com/demo/${site.name.toLowerCase().replace(/\W+/g, '-')}/pull/${n}`;
// [type, content, page, status, extra]
const drafts = [
  // Action Center, waiting on you
  ['meta-title', C['meta-title']('Salon Management Software: Booking, Staff and Payments', 'Salon Software for Bookings, Staff and Payments'), '/blog/salon-management-software/', 'submitted_for_approval', { created: ago(2) }],
  ['faq', C.faq(), '/blog/spa-management-software/', 'submitted_for_approval', { created: ago(1) }],
  ['schema', C.schema(), '/blog/gym-membership-management/', 'draft', { created: ago(1) }],
  ['open-graph', C['open-graph'](), '/about/', 'draft', { created: ago(0) }],
  // approved, branch pushed, and a PR waiting on a person
  ['internal-links', C['internal-links'](), '/pricing/', 'approved', { created: ago(3), approved: ago(2) }],
  ['html-lang', C['html-lang'](), '/blog/walk-in-queue-management/', 'pr_opened', { created: ago(4), approved: ago(3), pr: 244, branch: 'agent/fixes-2026-11-17', base: 'main' }],
  // history: went live
  ['meta-title', C['meta-title']('Gym Membership Software: Plans, Billing and Check-in', 'Gym Membership Software for Studios'), '/blog/gym-membership-management/', 'implemented', { created: ago(12), approved: ago(11), pr: 238, branch: 'agent/fixes-2026-11-09', impl: ago(9, 14) }],
  ['faq', C.faq(), '/pricing/', 'implemented', { created: ago(14), approved: ago(13), pr: 236, branch: 'agent/fixes-2026-11-07', impl: ago(11, 11) }],
  ['schema', C.schema(), '/blog/salon-management-software/', 'implemented', { created: ago(20), approved: ago(19), pr: 231, branch: 'agent/fixes-2026-11-01', impl: ago(18, 10) }],
  ['open-graph', C['open-graph'](), '/blog/spa-management-software/', 'implemented', { created: ago(8), approved: ago(7), pr: 241, branch: 'agent/fixes-2026-11-13', impl: ago(5, 16) }],
  ['html-lang', C['html-lang'](), '/', 'implemented', { created: ago(6), approved: ago(5), pr: 242, branch: 'agent/fixes-2026-11-15', impl: ago(3, 12) }],
  ['internal-links', C['internal-links'](), '/blog/salon-management-software/', 'abandoned', { created: ago(15), abandoned: ago(14), reason: 'Skipped by the client: not relevant' }],
  // Content
  ['blog-outline', C['blog-outline']('How salon software cuts no-shows by a third'), '/blog/how-salon-software-cuts-no-shows/', 'submitted_for_approval', { created: ago(2) }],
  ['landing-page', C['landing-page']('Never lose a walk-in again'), '/barbershops/', 'submitted_for_approval', { created: ago(1) }],
  ['translation', C.translation(), '/ne/blog/salon-management-software/', 'draft', { created: ago(0) }],
  ['blog-outline', C['blog-outline']('Gym membership software, compared'), '/blog/gym-membership-software-compared/', 'pr_opened', { created: ago(5), approved: ago(4), pr: 245, branch: 'agent/content-2026-11-16', base: 'main' }],
  ['blog-outline', C['blog-outline']('Spa software features that matter'), '/blog/spa-software-features/', 'implemented', { created: ago(16), approved: ago(15), pr: 233, branch: 'agent/content-2026-11-04', impl: ago(13, 15) }],
  ['landing-page', C['landing-page']('Salon software pricing, explained'), '/pricing-explained/', 'implemented', { created: ago(10), approved: ago(9), pr: 239, branch: 'agent/content-2026-11-10', impl: ago(7, 13) }],
  ['translation', C.translation(), '/ne/blog/spa-management-software/', 'implemented', { created: ago(9), approved: ago(8), pr: 240, branch: 'agent/content-2026-11-12', impl: ago(6, 10) }],
  ['blog-outline', C['blog-outline']('Walk-in queue tips for barbershops'), '/blog/walk-in-queue-tips/', 'implemented', { created: ago(25), approved: ago(24), pr: 226, branch: 'agent/content-2026-10-27', impl: ago(22, 11) }],
];
// The source decides the signal family a fix is listed under (SEO / AEO / GEO), as for real fixes; content types come from the studio.
const SOURCE = { faq: 'ai-visibility', schema: 'geo-signals', 'blog-outline': 'content', 'landing-page': 'content', translation: 'content' };
let i = 0;
for (const [type, content, page, status, x] of drafts) {
  i += 1;
  await q(`INSERT INTO drafts (site_id, action_type, source, finding_origin, finding_id, input, content, status, created_at, updated_at, approved_at, implemented_at,
                              branch_name, pr_number, pr_url, pr_state, pr_base_branch, abandoned_at, abandoned_reason)
           VALUES ($1,$2,$18,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [siteId, type, TAG, `${TAG}-draft-${i}`, JSON.stringify({ page }), JSON.stringify(content), status, x.created, x.approved || null, x.impl || null,
      x.branch || null, x.pr || null, x.pr ? prUrl(x.pr) : null, x.pr ? (status === 'implemented' ? 'merged' : 'open') : null, x.base || (x.pr ? 'main' : null), x.abandoned || null, x.reason || null, SOURCE[type] || 'technical-seo']);
}
// The demo project's own look, so previews are drawn in a real client's design: Zennly's serif headings, sans body text and teal brand
// colour, as the design profile would record them from a real site. Its website points at the tiny local stand-in (local-demo-site.js),
// which is where the preview reads the web-font links from.
const text = (tag, fontFamily, fontSize, fontWeight, color, lineHeight, role = 'heading') => ({ tag, role, style: { fontFamily, fontSize, fontWeight, color, lineHeight } });
const profile = { color: { border: 'border-gray-200', surface: 'bg-gray-50' }, pages: [{ sections: [{ textHierarchy: [
  text('h1', 'Fraunces, Georgia, serif', '48px', '600', 'rgb(28, 43, 42)', '1.15'), text('h2', 'Fraunces, Georgia, serif', '30px', '600', 'rgb(28, 43, 42)', '1.2'), text('h3', 'Fraunces, Georgia, serif', '20px', '600', 'rgb(28, 43, 42)', '1.3'),
  text('p', "'DM Sans', 'Noto Sans Devanagari', sans-serif", '17px', '400', 'rgb(74, 93, 91)', '1.65', 'body')] }] }] };
await q(`UPDATE sites SET brand_color = '#0f766e', website_domain = $2,
         url_file_map = jsonb_set(coalesce(url_file_map, '{}'::jsonb), '{siteRoot}', coalesce(url_file_map->'siteRoot', '{}'::jsonb) || jsonb_build_object('designProfile', $3::jsonb)) WHERE id = $1`,
  [siteId, `http://localhost:${process.env.DEMO_SITE_PORT || 4010}`, JSON.stringify(profile)]);
console.log(`Added ${issues.length} open issues, ${ideas.length} content ideas and ${drafts.length} drafts (waiting, approved, in review, live, skipped) for ${site.name}. Remove with --remove.`);
await pool.end();
