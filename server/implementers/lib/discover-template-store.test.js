import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const { autoHealTemplateDataStore } = await import('./discover-template-store.js');

const KEYS = ['alpha-post', 'beta-post', 'gamma-post', 'delta-post', 'epsilon-post', 'zeta-post'];
const TEMPLATE = `import { postFaqs } from "@/data/post-faqs";\nimport { postSeoOverrides } from "@/data/post-seo-overrides";\nexport default function P() { const a = postFaqs[post.slug.current]; const b = postSeoOverrides[post.slug.current]; }`;
const faqs = `export const postFaqs = {\n${KEYS.map((k) => `  "${k}": [{ question: "Q?", answer: "A." }],`).join('\n')}\n};\n`;
const seo = `export const postSeoOverrides = {\n${KEYS.map((k) => `  "${k}": { title: "T", description: "D" },`).join('\n')}\n};\n`;
const FILES = { 'src/app/[slug]/page.tsx': TEMPLATE, 'src/data/post-faqs.ts': faqs, 'src/data/post-seo-overrides.ts': seo, ...Object.fromEntries(KEYS.map((k) => [`src/content/blog/posts/${k}.json`, '{}'])) };

const site = (over = {}) => ({
  id: 8862, website_domain: 'example.com',
  url_file_map: { patterns: [{ match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx' }], pages: { '/birgunj': { file: 'src/app/birgunj/page.tsx' } }, ...over },
});
const deps = () => {
  const calls = { persisted: null, recorded: [] };
  return {
    calls,
    fetchTree: async () => ({ files: Object.keys(FILES) }),
    fetchFile: async (_s, p) => (FILES[p] != null ? { content: FILES[p] } : null),
    branch: 'main',
    persist: async (x) => { calls.persisted = x; return { id: 8862, url_file_map: x.urlFileMap }; },
    record: async (id, r) => { calls.recorded.push([id, r]); },
  };
};

describe('autoHealTemplateDataStore: a post\'s body (expand-content)', () => {
  const blk = (t) => ({ _key: 'k', _type: 'block', children: [{ _key: 's', _type: 'span', marks: [], text: t }], markDefs: [], style: 'normal' });
  const BODY = {
    ...FILES,
    'src/app/[slug]/page.tsx': `import PortableTextRenderer from "@/components/PortableTextRenderer";\n${TEMPLATE}`,
    'src/components/PortableTextRenderer.tsx': 'import { PortableText } from "@portabletext/react";\nconst c = { block: { h2: 1, normal: 1 }, types: { image: 1, rawHtml: 1 } };',
    ...Object.fromEntries(KEYS.map((k) => [`src/content/blog/posts/${k}.json`, JSON.stringify({ title: k, content: [blk('text')] }, null, 2) + '\n'])),
  };
  const bodyDeps = () => { const d = deps(); d.fetchTree = async () => ({ files: Object.keys(BODY) }); d.fetchFile = async (_s, p) => (BODY[p] != null ? { content: BODY[p] } : null); return d; };

  test('the body adapter is discovered from the same evidence and saved for that page', async () => {
    const d = bodyDeps();
    const out = await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'expand-content', d);
    assert.ok(out);
    const saved = d.calls.persisted.urlFileMap.pages['/alpha-post'].adapters['expand-content'];
    assert.equal(saved.id, 'portable-text-post-body');
    assert.equal(saved.contentFile, 'src/content/blog/posts/{key}.json');
    assert.equal(saved.rendererFile, 'src/components/PortableTextRenderer.tsx');
    assert.equal(saved.urlPattern, '^/([^/]+)/?$');
    assert.equal(d.calls.recorded[0][1].outcome, 'repaired');
  });
  test('a Q&A (qa-content) is body text, so it gets the body adapter, never the FAQ store', async () => {
    const d = bodyDeps();
    await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'qa-content', d);
    const adapters = d.calls.persisted.urlFileMap.pages['/alpha-post'].adapters;
    assert.equal(adapters['qa-content'].id, 'portable-text-post-body');
    assert.equal(adapters.faq, undefined);
  });
  test('a refreshed section (refresh-content) is written where an expanded one is', async () => {
    const d = bodyDeps();
    await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'refresh-content', d);
    assert.equal(d.calls.persisted.urlFileMap.pages['/alpha-post'].adapters['refresh-content'].id, 'portable-text-post-body');
  });
  test('a site whose posts are not block JSON gets nothing, and the page stays honestly blocked', async () => {
    const d = deps();
    assert.equal(await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'expand-content', d), null);
    assert.equal(d.calls.persisted, null);
    assert.equal(d.calls.recorded[0][1].outcome, 'ambiguous');
  });
});

describe('autoHealTemplateDataStore', () => {
  test('a post page on the shared template gets the FAQ adapter saved for THAT page, with the key pattern and the proof for new keys', async () => {
    const d = deps();
    const out = await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'faq', d);
    assert.ok(out);
    const saved = d.calls.persisted.urlFileMap.pages['/alpha-post'].adapters.faq;
    assert.deepEqual(saved, { id: 'ts-named-export-content', dataFile: 'src/data/post-faqs.ts', exportName: 'postFaqs', shape: 'keyed-record', allowCreateKey: true, keyEvidence: { file: 'src/content/blog/posts/{key}.json' }, urlPattern: '^/([^/]+)/?$' });
    assert.equal(d.calls.recorded[0][1].outcome, 'repaired');
    assert.equal(d.calls.recorded[0][1].capabilityType, 'url-file-map-adapter');
  });
  test('the pattern itself is never changed, so pages with files of their own keep their route', async () => {
    const d = deps();
    await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'meta-title', d);
    const cfg = d.calls.persisted.urlFileMap;
    assert.equal(cfg.patterns[0].adapters, undefined);
    assert.equal(cfg.pages['/birgunj'].adapters, undefined);
    assert.equal(cfg.pages['/alpha-post'].adapters['meta-title'].id, 'ts-keyed-record-fields');
  });
  test('a page that has a file of its own is not this case', async () => {
    const d = deps();
    assert.equal(await autoHealTemplateDataStore(site(), 'https://example.com/birgunj', 'faq', d), null);
    assert.equal(d.calls.persisted, null);
  });
  test('an adapter that is already configured for the page is never overwritten', async () => {
    const d = deps();
    const s = site({ pages: { '/alpha-post': { adapters: { faq: { id: 'page-data-object' } } } } });
    assert.equal(await autoHealTemplateDataStore(s, 'https://example.com/alpha-post', 'faq', d), null);
    assert.equal(d.calls.persisted, null);
  });
  test('an action no store adapter writes is left to the gate, untouched', async () => {
    const d = deps();
    assert.equal(await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'expand-content', d), null);
    assert.equal(d.calls.persisted, null);
  });
  test('a pattern whose key is not the single capture group is refused: the key would be a guess', async () => {
    const d = deps();
    const s = site({ patterns: [{ match: '^/(blog|news)/([^/]+)/?$', file: 'src/app/[slug]/page.tsx' }] });
    assert.equal(await autoHealTemplateDataStore(s, 'https://example.com/blog/alpha-post', 'faq', d), null);
    assert.equal(d.calls.persisted, null);
  });
  test('a template with no store for the action records why and saves nothing', async () => {
    const d = deps();
    d.fetchFile = async (_s, p) => (p === 'src/app/[slug]/page.tsx' ? { content: 'import X from "@/components/X";\nexport default function P() { return <X/>; }' } : FILES[p] != null ? { content: FILES[p] } : null);
    assert.equal(await autoHealTemplateDataStore(site(), 'https://example.com/alpha-post', 'faq', d), null);
    assert.equal(d.calls.persisted, null);
    assert.equal(d.calls.recorded[0][1].outcome, 'ambiguous');
  });
});
