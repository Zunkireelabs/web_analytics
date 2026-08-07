import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';

export const meta = {
  id: 'translation',
  name: 'Translation Generator',
  description: 'Drafts a translation of a page\'s title, meta description, and key content into a target language.',
  recommendationTags: [], // sourced from country-intelligence's topLanguages/growingMarkets, not a deterministic gap tag
};

const KEY_CONTENT_CHARS = 2000;

// params: { page?: string, text?: string, targetLanguage: string }
export async function generate({ siteId, params }) {
  const { page, text, targetLanguage } = params;
  if (!targetLanguage) throw Object.assign(new Error('targetLanguage is required'), { status: 400 });
  if (!page && !text) throw Object.assign(new Error('page or text is required'), { status: 400 });

  let title = '';
  let metaDescription = '';
  let keyContent = text || '';
  if (page) {
    const fetched = await analyzePageUrl(page);
    if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
    title = fetched.analysis.title;
    metaDescription = fetched.analysis.metaDescription;
    keyContent = fetched.analysis.bodyText.slice(0, KEY_CONTENT_CHARS);
  }

  const system = `You are a professional translator. Translate the given content into ${targetLanguage}, ` +
    'preserving meaning and tone — do not summarize, add, or omit information. Respond with ONLY a JSON object: ' +
    '{"translatedTitle": "...", "translatedMetaDescription": "...", "translatedContent": "..."} (use empty ' +
    'strings for any field with no corresponding source text).';
  const user = `Title: ${title}\nMeta description: ${metaDescription}\nContent: ${keyContent}`;
  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { maxTokens: 1500, generatorId: meta.id, siteId });
  } catch {
    throw Object.assign(new Error('Translation generation failed: model did not return valid JSON'), { status: 400 });
  }

  const content = {
    page: page || null,
    targetLanguage,
    sourceTitle: title,
    sourceMetaDescription: metaDescription,
    sourceContent: keyContent,
    translatedTitle: parsed.translatedTitle || '',
    translatedMetaDescription: parsed.translatedMetaDescription || '',
    translatedContent: parsed.translatedContent || '',
  };
  return { content, summary: `${targetLanguage} translation draft` + (page ? ` for ${page}` : '') };
}
