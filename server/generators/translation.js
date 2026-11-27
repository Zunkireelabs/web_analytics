import { analyzePageUrl, requireGroundedContent } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { llmFailure } from './lib/llm-error.js';
import { translatePostFile } from './lib/translate-post.js';

export const meta = {
  id: 'translation',
  name: 'Translation Generator',
  description: 'Drafts a translation of a page\'s title, meta description, and key content into a target language.',
  recommendationTags: [], // sourced from country-intelligence's topLanguages/growingMarkets, not a deterministic gap tag
};

const KEY_CONTENT_CHARS = 2000;

// A page whose source is a markdown file is translated WHOLE: every section, table, FAQ block, sources list, related-article links and call to action
// (generators/lib/translate-post.js). It used to be the first 2,000 characters of plain text, which came out at about half the post with none of those.
// Other sources (templates, components) keep the key-content translation below. Loaded on demand: these reach the database and GitHub.
async function translateWholePost({ siteId, page, targetLanguage }) {
  const [{ getSiteById }, { resolveFile }, { getFileContent }, { baseBranch }, { callLLM }] = await Promise.all([
    import('../store/read.js'), import('../implementers/lib/url-file-map.js'), import('../github/client.js'), import('../implementers/lib/github-ops.js'), import('../llm.js'),
  ]);
  const site = await getSiteById(siteId);
  const sourcePath = site ? resolveFile(site, page) : null;
  if (!sourcePath || !/\.(md|markdown)$/i.test(sourcePath)) return null;
  const file = await getFileContent(site, sourcePath, baseBranch(site));
  if (!file?.content) throw Object.assign(new Error(`Could not read the source file ${sourcePath} to translate the whole post.`), { status: 502 });
  return translatePostFile({
    raw: file.content, targetLanguage,
    translateText: (system, user, { maxTokens }) => callLLM(system, user, { maxTokens, task: 'content', generatorId: meta.id, siteId }),
  });
}

// params: { page?: string, text?: string, targetLanguage: string }
export async function generate({ siteId, params }) {
  const { page, text, targetLanguage, designCorrections } = params;
  if (!targetLanguage) throw Object.assign(new Error('targetLanguage is required'), { status: 400 });
  if (!page && !text) throw Object.assign(new Error('page or text is required'), { status: 400 });

  let title = '';
  let metaDescription = '';
  let keyContent = text || '';
  if (page) {
    const fetched = await analyzePageUrl(page);
    if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
    requireGroundedContent(fetched.analysis, { generatorId: meta.id });
    title = fetched.analysis.title;
    metaDescription = fetched.analysis.metaDescription;
    keyContent = fetched.analysis.bodyText.slice(0, KEY_CONTENT_CHARS);
  }

  if (page && !text) {
    const whole = await translateWholePost({ siteId, page, targetLanguage }).catch((err) => { throw err.translationStructure ? err : llmFailure(err, err.message, { status: err.status || 400 }); });
    if (whole) {
      return {
        content: {
          page, targetLanguage, sourceTitle: title, sourceMetaDescription: metaDescription, sourceContent: keyContent,
          translatedTitle: whole.title || '', translatedMetaDescription: whole.description || '', translatedContent: whole.body, translatedFile: whole.file, wholePost: true,
          // What the generator put in the three editable fields, so a later edit can be told from the original and written into the file (implementers/frontend.js).
          translatedFileParts: { title: whole.title || '', description: whole.description || '', body: whole.body },
        },
        summary: `${targetLanguage} translation draft (whole post, ${whole.chunks} part${whole.chunks === 1 ? '' : 's'}) for ${page}`,
      };
    }
  }

  const system = `You are a professional translator. Translate the given content into ${targetLanguage}, ` +
    'preserving meaning and tone — do not summarize, add, or omit information. Respond with ONLY a JSON object: ' +
    '{"translatedTitle": "...", "translatedMetaDescription": "...", "translatedContent": "..."} (use empty ' +
    'strings for any field with no corresponding source text).';
  const user = `Title: ${title}\nMeta description: ${metaDescription}\nContent: ${keyContent}`
    + (designCorrections ? `\n\n${designCorrections}` : '');
  let parsed;
  try {
    parsed = await callLLMForJson(system, user, { task: 'content', maxTokens: 1500, generatorId: meta.id, siteId });
  } catch (err) {
    throw llmFailure(err, 'Translation generation failed: model did not return valid JSON', { status: 400 });
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
