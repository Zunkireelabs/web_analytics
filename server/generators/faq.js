import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

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
const PAGE_PURPOSE_GUIDANCE = {
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

// params: { page?: string, query?: string, topic?: string, schemaType?: string }
export async function generate({ params }) {
  const { page, query, topic, schemaType } = params;
  const subject = query || topic;
  if (!subject) throw Object.assign(new Error('query or topic is required'), { status: 400 });

  let bodyExcerpt = null;
  if (page) {
    const fetched = await analyzePageUrl(page);
    if (fetched.ok) bodyExcerpt = fetched.analysis.bodyText.slice(0, 3000);
  }

  const pageGuidance = schemaType ? PAGE_PURPOSE_GUIDANCE[schemaType] : null;

  const system = 'You are a content strategist. Given a real target query/topic and (if available) the page\'s ' +
    'real body text, draft 4-6 FAQ question/answer pairs a reader would realistically ask. Ground every answer ' +
    'ONLY in the page content given — never invent a feature, price, policy, or fact not present in the excerpt; ' +
    'if the page text doesn\'t support a specific answer, write a general, non-committal answer instead. If no ' +
    'page content is given, write general informational answers about the topic only. ' +
    (pageGuidance ? `${pageGuidance} ` : '') +
    'Respond with ONLY a JSON array: [{"question": "...", "answer": "..."}, ...]';
  const user = `Subject: ${subject}\n${bodyExcerpt ? `Page text: ${bodyExcerpt}` : 'No existing page — new content.'}`;
  const raw = await callLLM(system, user, { maxTokens: 900 });

  let items;
  try {
    items = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(items)) throw new Error('not an array');
  } catch {
    throw Object.assign(new Error('FAQ generation failed: model did not return valid JSON'), { status: 400 });
  }
  items = items.filter((i) => i && typeof i.question === 'string' && typeof i.answer === 'string').slice(0, 8);

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
