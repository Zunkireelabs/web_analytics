import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const SOURCE = '---\ntitle: "Hello"\ndescription: "A post."\ntags:\n  - X\n---\n\n## One\n\nText one.\n\n## Sources\n\n<ul><li><a href="https://x.org/a" rel="noopener">Source A</a></li></ul>\n';
mock.module(resolve('../agents/lib/page-content.js'), { namedExports: {
  analyzePageUrl: async () => ({ ok: true, analysis: { title: 'Hello', metaDescription: 'A post.', bodyText: 'Text one. '.repeat(400) } }),
  requireGroundedContent: () => {},
} });
mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => ({ id: 1 }) } });
mock.module(resolve('../implementers/lib/url-file-map.js'), { namedExports: { resolveFile: (_s, page) => (page.includes('md') ? 'src/blog/hello.md' : 'src/pages/about.njk') } });
mock.module(resolve('../github/client.js'), { namedExports: { getFileContent: async () => ({ content: SOURCE }) } });
mock.module(resolve('../implementers/lib/github-ops.js'), { namedExports: { baseBranch: () => 'main' } });
mock.module(resolve('../llm.js'), { namedExports: {
  callLLM: async (_s, user) => (user.trim().startsWith('{') ? '{"title":"Hallo","description":"Ein Beitrag."}' : user.replace('Text one.', 'Text eins.').replace('Source A', 'Quelle A').replace('One', 'Eins').replace('Sources', 'Quellen')),
  callLLMForJson: async () => ({ translatedTitle: 'T', translatedMetaDescription: 'M', translatedContent: 'short' }),
} });
const { generate } = await import(resolve('./translation.js'));

describe('translation generator', () => {
  test('a markdown source is translated whole: the full translated file is on the draft, with the sources list kept', async () => {
    const r = await generate({ siteId: 1, params: { page: 'https://s.example/blog/hello-md/', targetLanguage: 'German' } });
    assert.equal(r.content.wholePost, true);
    assert.match(r.content.translatedFile, /^---\ntitle: "Hallo"/);
    assert.match(r.content.translatedFile, /<li><a href="https:\/\/x\.org\/a" rel="noopener">Quelle A<\/a><\/li>/);
    assert.ok(!/^tags:/m.test(r.content.translatedFile));
    assert.match(r.content.translatedContent, /Text eins\./);
  });
  test('a non-markdown source keeps the key-content translation, exactly as before', async () => {
    const r = await generate({ siteId: 1, params: { page: 'https://s.example/about/', targetLanguage: 'German' } });
    assert.equal(r.content.wholePost, undefined);
    assert.equal(r.content.translatedContent, 'short');
  });
});
