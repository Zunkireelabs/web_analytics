import { analyzePageUrl, hasSufficientGroundingContent } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { getSiteById } from '../store/read.js';
import { findRealFaqDataSource } from './lib/faq-data-source.js';
import { pageStructureGuidance } from './lib/design-aware-composer.js';

export const meta = {
  id: 'faq',
  name: 'FAQ Generator',
  description: 'Drafts an FAQ section (and matching FAQPage schema) grounded in the real page content and target query/topic.',
  recommendationTags: ['Add FAQ', 'Missing FAQ'],
};

// Page types whose FAQ should be about the PAGE'S OWN PURPOSE rather than
// the site's top-ranking query for that URL — a utility page (contact,
// about) often ranks for a generic branded query that has nothing to do
// with what a visitor to that specific page actually wants to ask. Every
// other schemaType (Article, Product, Organization, FAQPage, ...) keeps the
// existing query-grounded behavior, which fits regular content pages fine.
export const PAGE_PURPOSE_GUIDANCE = {
  ContactPage: 'This is a Contact page. Write FAQs a visitor trying to reach the company would realistically ' +
    'ask — e.g. how to get in touch, response times, support channels, office location, how to schedule a call. ' +
    'Do NOT write generic company/product FAQs (what products/services exist, what industries are served, etc.) ' +
    '— that content belongs on other pages, not here.',
  AboutPage: 'This is an About page. Write FAQs about the company itself — its history, founding, mission, team, ' +
    'locations. Do NOT write product/pricing/support FAQs — that content belongs on other pages, not here.',
  // The homepage (page-content.js's inferSchemaType returns 'Organization'
  // for a bare root path when no more specific schema exists) has the same
  // branded-query mismatch as Contact/About: its top GSC query is usually
  // the company name itself, which isn't a real FAQ subject on its own.
  Organization: 'This is the site\'s homepage. Write FAQs a first-time visitor would ask before deciding to ' +
    'explore further — what the company/product actually does, who it\'s for, how to get started, pricing/plans ' +
    'at a high level (only if the page text supports it). Do NOT write deep product-specific or support FAQs ' +
    '— that content belongs on other pages, not here.',
};

// The real-evidence-grounded LLM draft itself — factored out of generate()
// below so content-integrity-repair.js's 'faq-topic-mismatch' fix (correcting
// an EXISTING visible FAQ whose questions don't match its own page) can reuse
// the exact same grounding/prompt this generator uses for a net-new FAQ,
// rather than a second, driftable copy of the same prompt. Deliberately
// excludes findRealFaqDataSource's organic-FAQ refusal gate below — that gate
// exists to stop THIS generator from drafting a second, competing FAQ over a
// page's real existing one; a repair fix is the opposite case (the existing
// one IS the thing being corrected), so it calls this directly instead of
// going through generate().
//
// `expectedCount`, when given, asks the model for that exact number of pairs
// (a repair caller doing an exact 1:1 in-place text swap needs the count to
// match; net-new drafting leaves it unset and keeps the original 4-6 range).
export async function generateFaqItemsFromEvidence({ siteId, subject, bodyExcerpt, pageGuidance, structureGuidance, expectedCount } = {}) {
  const countInstruction = expectedCount
    ? `Write EXACTLY ${expectedCount} FAQ question/answer pairs — not more, not fewer. `
    : 'draft 4-6 FAQ question/answer pairs a reader would realistically ask. ';
  const system = 'You are a content strategist. Given a real target query/topic and (if available) the page\'s ' +
    `real body text, ${countInstruction}` +
    'Ground every answer ONLY in the page content given — never invent a feature, price, policy, or fact not ' +
    'present in the excerpt; if the page text doesn\'t support a specific answer, write a general, non-committal ' +
    'answer instead. If no page content is given, write general informational answers about the topic only. ' +
    (pageGuidance ? `${pageGuidance} ` : '') +
    'Respond with ONLY a JSON array: [{"question": "...", "answer": "..."}, ...]';
  const user = `Subject: ${subject}\n${bodyExcerpt ? `Page text: ${bodyExcerpt}` : 'No existing page — new content.'}` +
    (structureGuidance ? `\n\n${structureGuidance}` : '');
  let items;
  try {
    items = await callLLMForJson(system, user, { maxTokens: 900, generatorId: meta.id, siteId });
    if (!Array.isArray(items)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('FAQ generation failed: model did not return valid JSON'), { status: 400 });
  }
  return items.filter((i) => i && typeof i.question === 'string' && typeof i.answer === 'string').slice(0, expectedCount || 8);
}

// params: { page?: string, query?: string, topic?: string, schemaType?: string }
export async function generate({ siteId, params }) {
  const { page, query, topic, schemaType } = params;
  const subject = query || topic;
  if (!subject) throw Object.assign(new Error('query or topic is required'), { status: 400 });

  const site = await getSiteById(siteId).catch(() => null);

  // Prefer the page's own REAL, already-existing FAQ data over LLM
  // fabrication whenever one exists — never invent a second, possibly
  // mismatched FAQ for a page that already answers these questions for
  // real (real incident, 2026-08-25: /resources/ ended up with two
  // disagreeing FAQ sources — a real organic accordion and this
  // generator's own fabricated schema — because nothing here ever checked
  // for real data first). When real data can't be confirmed but organic
  // FAQ evidence still exists (a hand-authored accordion with no readable
  // backing data file), refuse outright rather than risk the same
  // mismatch — see faq-data-source.js's return contract.
  if (page) {
    const dataSource = await findRealFaqDataSource(site, page);
    if (dataSource?.ok) {
      const items = dataSource.items;
      const schemaJsonLd = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: items.map((i) => ({
          '@type': 'Question',
          name: i.question,
          acceptedAnswer: { '@type': 'Answer', text: i.answer },
        })),
      };
      const content = { subject, page, items, schemaJsonLd, groundedInRealData: dataSource.dataFile };
      return { content, summary: `${items.length} real FAQ item(s) grounded in ${dataSource.dataFile}` };
    }
    if (dataSource && !dataSource.ok && dataSource.organicSignal) {
      throw Object.assign(
        new Error(`"${page}" already has real FAQ content that couldn't be confidently read from the repo — drafting another FAQ risks disagreeing with it. Add/update it by hand instead.`),
        { status: 400, userFacing: true, refusal: true },
      );
    }
  }

  let bodyExcerpt = null;
  if (page) {
    const fetched = await analyzePageUrl(page);
    // A thin/empty extraction (client-side-rendered content, or a genuinely
    // nav-only page) is treated the same as a failed fetch: fall through to
    // this generator's existing "no page content given" mode rather than
    // grounding the FAQ in whatever boilerplate is left.
    if (fetched.ok && hasSufficientGroundingContent(fetched.analysis)) bodyExcerpt = fetched.analysis.bodyText.slice(0, 3000);
  }

  const pageGuidance = schemaType ? PAGE_PURPOSE_GUIDANCE[schemaType] : null;
  // DESIGN CONTEXT REACHES GENERATION HERE — this site's own real FAQ
  // structure (how many questions it typically shows, what text roles the
  // page uses) informs the generated Q&A set. The actual accordion/list
  // MARKUP still comes from componentTemplates' projectFaq at render time —
  // this only shapes the CONTENT decision, not the styling.
  const structureGuidance = pageStructureGuidance(site, 'faq');

  const items = await generateFaqItemsFromEvidence({ siteId, subject, bodyExcerpt, pageGuidance, structureGuidance });

  // FAQPage JSON-LD is a deterministic transform of the items, not a
  // separate LLM call — nothing here can drift from what's shown above.
  const schemaJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.question,
      acceptedAnswer: { '@type': 'Answer', text: i.answer },
    })),
  };

  const content = { subject, page: page || null, items, schemaJsonLd };
  return { content, summary: `${items.length} FAQ item(s) for "${subject}"` };
}
