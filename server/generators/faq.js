import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLM } from '../llm.js';

export const meta = {
  id: 'faq',
  name: 'FAQ Generator',
  description: 'Drafts an FAQ section (and matching FAQPage schema) grounded in the real page content and target query/topic.',
  recommendationTags: ['Add FAQ', 'Missing FAQ'],
};

// params: { page?: string, query?: string, topic?: string }
export async function generate({ params }) {
  const { page, query, topic } = params;
  const subject = query || topic;
  if (!subject) throw Object.assign(new Error('query or topic is required'), { status: 400 });

  let bodyExcerpt = null;
  if (page) {
    const fetched = await analyzePageUrl(page);
    if (fetched.ok) bodyExcerpt = fetched.analysis.bodyText.slice(0, 3000);
  }

  const system = 'You are a content strategist. Given a real target query/topic and (if available) the page\'s ' +
    'real body text, draft 4-6 FAQ question/answer pairs a reader would realistically ask. Ground every answer ' +
    'ONLY in the page content given — never invent a feature, price, policy, or fact not present in the excerpt; ' +
    'if the page text doesn\'t support a specific answer, write a general, non-committal answer instead. If no ' +
    'page content is given, write general informational answers about the topic only. Respond with ONLY a JSON ' +
    'array: [{"question": "...", "answer": "..."}, ...]';
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
